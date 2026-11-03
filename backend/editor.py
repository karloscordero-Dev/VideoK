import os
import subprocess
import json
import re
import urllib.parse
import math

# Prepend local bin directory to PATH so all subprocesses/libraries can resolve ffmpeg/ffprobe
LOCAL_BIN_DIR = "/Users/carloscorderolizana/.gemini/antigravity/bin"
os.environ["PATH"] = LOCAL_BIN_DIR + os.pathsep + os.environ.get("PATH", "")

# Define paths to localized FFmpeg/FFprobe binaries on Apple Silicon
FFMPEG_PATH = "/Users/carloscorderolizana/.gemini/antigravity/bin/ffmpeg"
FFPROBE_PATH = "/Users/carloscorderolizana/.gemini/antigravity/bin/ffprobe"

# Fallback to system-wide paths if the localized ones don't exist
if not os.path.exists(FFMPEG_PATH):
    FFMPEG_PATH = "ffmpeg"
if not os.path.exists(FFPROBE_PATH):
    FFPROBE_PATH = "ffprobe"

def get_media_info(file_path):
    """
    Probes the media file using ffprobe to get duration, fps, width, height, and sample rate.
    """
    cmd = [
        FFPROBE_PATH,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        file_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise Exception(f"Error al analizar el archivo de video: {result.stderr}")
    
    data = json.loads(result.stdout)
    
    # Get duration
    duration = float(data.get("format", {}).get("duration", 0.0))
    
    # Find video and audio streams
    video_stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    
    fps = 30.0  # Default fallback
    width = 1920
    height = 1080
    
    if video_stream:
        r_frame_rate = video_stream.get("r_frame_rate", "30/1")
        if "/" in r_frame_rate:
            num, den = r_frame_rate.split("/")
            if float(den) > 0:
                fps = float(num) / float(den)
        width = int(video_stream.get("width", 1920))
        height = int(video_stream.get("height", 1080))
        
    sample_rate = 44100
    if audio_stream:
        sample_rate = int(audio_stream.get("sample_rate", 44100))
        
    return {
        "duration": duration,
        "fps": fps,
        "width": width,
        "height": height,
        "has_video": video_stream is not None,
        "has_audio": audio_stream is not None,
        "sample_rate": sample_rate,
        "name": os.path.basename(file_path),
        "path": file_path
    }

def detect_silences(video_path, noise_threshold_db=-30, min_silence_len=0.5):
    """
    Uses FFmpeg's silencedetect filter to find silence periods.
    """
    cmd = [
        FFMPEG_PATH,
        "-i", video_path,
        "-af", f"silencedetect=n={noise_threshold_db}dB:d={min_silence_len}",
        "-f", "null",
        "-"
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    silences = []
    start_re = re.compile(r"silence_start:\s+([\d\.]+)")
    end_re = re.compile(r"silence_end:\s+([\d\.]+)\s+\|\s+silence_duration:\s+([\d\.]+)")
    
    current_start = None
    
    for line in result.stderr.splitlines():
        start_match = start_re.search(line)
        if start_match:
            current_start = float(start_match.group(1))
        
        end_match = end_re.search(line)
        if end_match:
            end_val = float(end_match.group(1))
            duration = float(end_match.group(2))
            if current_start is not None:
                silences.append((current_start, end_val))
                current_start = None
            else:
                silences.append((end_val - duration, end_val))
                
    return silences

def get_keep_segments(silences, duration):
    """
    Inverts silence segments to get the segments that contain active audio/speech.
    """
    if not silences:
        return [(0.0, duration)]
        
    keep = []
    last_end = 0.0
    
    for start, end in silences:
        if start > last_end:
            keep.append((last_end, start))
        last_end = end
        
    if last_end < duration:
        keep.append((last_end, duration))
        
    return keep

def pad_and_merge_segments(keep_segments, duration, padding=0.2):
    """
    Applies padding to keep-segments and merges any overlapping segments.
    """
    if not keep_segments:
        return []
        
    padded = []
    for start, end in keep_segments:
        padded.append((max(0.0, start - padding), min(duration, end + padding)))
        
    padded.sort(key=lambda x: x[0])
    
    merged = [padded[0]]
    for current in padded[1:]:
        prev_start, prev_end = merged[-1]
        curr_start, curr_end = current
        
        if curr_start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, curr_end))
        else:
            merged.append(current)
            
    return [(s, e) for s, e in merged if (e - s) > 0.1]

def export_mp4_fast(video_path, segments, output_path):
    """
    Slices and merges video segments using FFmpeg VideoToolbox hardware acceleration (Mac GPU).
    This guarantees perfect audio/video synchronization and applies a 10ms fade to prevent audio clicks/pops.
    """
    if not segments:
        raise Exception("No hay segmentos que exportar.")
        
    filter_parts = []
    inputs_str = ""
    
    for idx, (start, end) in enumerate(segments):
        duration = end - start
        fade_out_start = max(0.0, duration - 0.01)
        
        # Video trim & reset pts
        filter_parts.append(f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[v{idx}]")
        
        # Audio trim, reset pts, and apply 10ms fades to prevent clicks
        filter_parts.append(
            f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d=0.01,afade=t=out:st={fade_out_start:.3f}:d=0.01[a{idx}]"
        )
        inputs_str += f"[v{idx}][a{idx}]"
        
    # Combine everything with concat filter
    filter_parts.append(f"{inputs_str}concat=n={len(segments)}:v=1:a=1[outv][outa]")
    filter_complex_str = "; ".join(filter_parts)
    
    cmd = [
        FFMPEG_PATH,
        "-y",
        "-i", video_path,
        "-filter_complex", filter_complex_str,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "h264_videotoolbox",
        "-b:v", "6000k",  # 6 Mbps target bitrate
        "-c:a", "aac",
        "-b:a", "192k",
        output_path
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        raise Exception(f"FFmpeg export failed: {result.stderr}")
        
    return output_path

def export_standard_xml(video_path, segments, output_path):
    """
    Generates standard FCP 7 XML (compatible with Premiere Pro and DaVinci Resolve).
    """
    info = get_media_info(video_path)
    fps = info["fps"]
    duration_secs = sum(end - start for start, end in segments)
    duration_frames = int(duration_secs * fps)
    
    abs_path = os.path.abspath(video_path)
    path_url = "file://localhost" + urllib.parse.quote(abs_path)
    
    xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml SYSTEM "fcpxml.dtd">
<xmeml version="5">
  <sequence id="sequence-1">
    <name>Silent Cut Sequence</name>
    <duration>{duration_frames}</duration>
    <rate>
      <timebase>{int(fps)}</timebase>
      <ntsc>{"TRUE" if int(fps) in (24, 30) and fps < float(int(fps)) else "FALSE"}</ntsc>
    </rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>{info["width"]}</width>
            <height>{info["height"]}</height>
            <rate>
              <timebase>{int(fps)}</timebase>
              <ntsc>{"TRUE" if int(fps) in (24, 30) and fps < float(int(fps)) else "FALSE"}</ntsc>
            </rate>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>"""
    
    # Video clip items
    current_timeline_frame = 0
    for idx, (start, end) in enumerate(segments):
        start_frame = int(start * fps)
        end_frame = int(end * fps)
        clip_duration = end_frame - start_frame
        
        xml_content += f"""
          <clipitem id="video-clip-{idx}">
            <name>{info["name"]}</name>
            <duration>{int(info["duration"] * fps)}</duration>
            <rate>
              <timebase>{int(fps)}</timebase>
            </rate>
            <in>{start_frame}</in>
            <out>{end_frame}</out>
            <start>{current_timeline_frame}</start>
            <end>{current_timeline_frame + clip_duration}</end>
            <file id="file-1">
              <name>{info["name"]}</name>
              <pathurl>{path_url}</pathurl>
              <rate>
                <timebase>{int(fps)}</timebase>
              </rate>
              <duration>{int(info["duration"] * fps)}</duration>
            </file>
          </clipitem>"""
        current_timeline_frame += clip_duration
        
    xml_content += """
        </track>
      </video>
      <audio>
        <track>"""
    
    # Audio track Left
    current_timeline_frame = 0
    for idx, (start, end) in enumerate(segments):
        start_frame = int(start * fps)
        end_frame = int(end * fps)
        clip_duration = end_frame - start_frame
        
        xml_content += f"""
          <clipitem id="audio-clip-l-{idx}">
            <name>{info["name"]}</name>
            <duration>{int(info["duration"] * fps)}</duration>
            <rate>
              <timebase>{int(fps)}</timebase>
            </rate>
            <in>{start_frame}</in>
            <out>{end_frame}</out>
            <start>{current_timeline_frame}</start>
            <end>{current_timeline_frame + clip_duration}</end>
            <file id="file-1"/>
          </clipitem>"""
        current_timeline_frame += clip_duration
        
    xml_content += """
        </track>
        <track>"""
    
    # Audio track Right
    current_timeline_frame = 0
    for idx, (start, end) in enumerate(segments):
        start_frame = int(start * fps)
        end_frame = int(end * fps)
        clip_duration = end_frame - start_frame
        
        xml_content += f"""
          <clipitem id="audio-clip-r-{idx}">
            <name>{info["name"]}</name>
            <duration>{int(info["duration"] * fps)}</duration>
            <rate>
              <timebase>{int(fps)}</timebase>
            </rate>
            <in>{start_frame}</in>
            <out>{end_frame}</out>
            <start>{current_timeline_frame}</start>
            <end>{current_timeline_frame + clip_duration}</end>
            <file id="file-1"/>
          </clipitem>"""
        current_timeline_frame += clip_duration
        
    xml_content += """
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>
"""
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(xml_content)
        
    return output_path

def format_fcpxml_time(time_seconds, fps):
    """
    Converts a time in seconds to an FCPXML compliant rational time string.
    Ensures that the time falls exactly on a frame boundary to prevent DTD import errors.
    """
    if abs(fps - 29.97) < 0.05:
        fps_num, fps_den = 30000, 1001
    elif abs(fps - 23.98) < 0.05:
        fps_num, fps_den = 24000, 1001
    elif abs(fps - 24.0) < 0.05:
        fps_num, fps_den = 24, 1
    elif abs(fps - 25.0) < 0.05:
        fps_num, fps_den = 25, 1
    elif abs(fps - 59.94) < 0.05:
        fps_num, fps_den = 60000, 1001
    elif abs(fps - 50.0) < 0.05:
        fps_num, fps_den = 50, 1
    else:
        fps_num, fps_den = round(fps), 1
        
    frames = round(time_seconds * (fps_num / fps_den))
    if frames == 0:
        return "0s"
        
    num = frames * fps_den
    den = fps_num
    g = math.gcd(int(num), int(den))
    return f"{int(num//g)}/{int(den//g)}s"

def export_fcpxml(video_path, segments, output_path):
    """
    Generates native FCPXML v1.9 (exclusive for Final Cut Pro).
    """
    info = get_media_info(video_path)
    fps = info["fps"]
    
    # Map frame rates
    if abs(fps - 29.97) < 0.05:
        frame_dur = "1001/30000s"
        format_name = "FFVideoFormat1080p2997"
    elif abs(fps - 23.98) < 0.05:
        frame_dur = "1001/24000s"
        format_name = "FFVideoFormat1080p2398"
    elif abs(fps - 24.0) < 0.05:
        frame_dur = "100/2400s"
        format_name = "FFVideoFormat1080p24"
    elif abs(fps - 25.0) < 0.05:
        frame_dur = "100/2500s"
        format_name = "FFVideoFormat1080p25"
    elif abs(fps - 59.94) < 0.05:
        frame_dur = "1001/60000s"
        format_name = "FFVideoFormat1080p5994"
    elif abs(fps - 50.0) < 0.05:
        frame_dur = "100/5000s"
        format_name = "FFVideoFormat1080p50"
    else:
        frame_dur = "100/3000s"
        format_name = "FFVideoFormat1080p30"
        
    abs_path = os.path.abspath(video_path)
    path_url = "file://" + urllib.parse.quote(abs_path)
    
    # Dynamically determine media tracks and resolution
    has_video = "1" if info.get("has_video", True) else "0"
    has_audio = "1" if info.get("has_audio", True) else "0"
    
    width = info.get("width", 1920)
    height = info.get("height", 1080)
    is_vertical = height > width if (width and height) else False
    
    if is_vertical:
        format_tag = f'<format id="r1" frameDuration="{frame_dur}" width="{width}" height="{height}"/>'
    else:
        format_tag = f'<format id="r1" name="{format_name}" frameDuration="{frame_dur}" width="{width}" height="{height}"/>'
        
    abs_path = os.path.abspath(video_path)
    path_url = "file://" + urllib.parse.quote(abs_path)
    
    duration_str = format_fcpxml_time(info["duration"], fps)
    
    xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
    <resources>
        {format_tag}
        <asset id="r2" name="{info["name"]}" start="0s" duration="{duration_str}" hasVideo="{has_video}" hasAudio="{has_audio}">
            <media-rep kind="original-media" src="{path_url}"/>
        </asset>"""
        
    sequence_duration_str = format_fcpxml_time(sum(end - start for start, end in segments), fps)
    
    base_name = os.path.splitext(info["name"])[0]
    xml_content += f"""
    </resources>
    <library>
        <event name="{base_name} Event">
            <project name="{base_name}">
                <sequence duration="{sequence_duration_str}" format="r1" tcStart="0s" tcFormat="NDF">
                    <spine>"""
    
    current_timeline_secs = 0.0
    for idx, (start, end) in enumerate(segments):
        clip_duration = end - start
        
        offset_str = format_fcpxml_time(current_timeline_secs, fps)
        start_str = format_fcpxml_time(start, fps)
        clip_dur_str = format_fcpxml_time(clip_duration, fps)
            
        xml_content += f"""
                        <asset-clip ref="r2" offset="{offset_str}" name="{info["name"]}" start="{start_str}" duration="{clip_dur_str}"/>"""
                        
        current_timeline_secs += clip_duration
        
    xml_content += """
                    </spine>
                </sequence>
            </project>
        </event>
    </library>
</fcpxml>
"""
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(xml_content)
        
    return output_path
