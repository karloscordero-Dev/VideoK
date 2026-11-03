import os
import subprocess
import uuid

# Prepend local bin directory to PATH so all libraries (like mlx-whisper) can find ffmpeg/ffprobe
LOCAL_BIN_DIR = "/Users/carloscorderolizana/.gemini/antigravity/bin"
os.environ["PATH"] = LOCAL_BIN_DIR + os.pathsep + os.environ.get("PATH", "")

from typing import List, Dict, Tuple, Optional
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Import processing logic
from editor import (
    get_media_info,
    detect_silences,
    get_keep_segments,
    pad_and_merge_segments,
    export_mp4_fast,
    export_standard_xml,
    export_fcpxml,
    FFMPEG_PATH
)

app = FastAPI(title="Smart Video Editor API")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In development, allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for active tasks
tasks_status: Dict[str, Dict] = {}

class SelectFolderResponse(BaseModel):
    path: str

class SelectFileResponse(BaseModel):
    path: str
    
class AnalyzeRequest(BaseModel):
    video_path: str
    run_whisper: bool = False
    whisper_model: str = "base" # "base", "small", "turbo"
    noise_threshold_db: float = -30.0
    min_silence_len: float = 0.5
    padding: float = 0.2

class AnalyzeResponse(BaseModel):
    status: str
    task_id: str
    message: str

class ExportRequest(BaseModel):
    video_path: str
    output_path: str
    export_format: str # "mp4", "fcpxml", "xml", "mov"
    segments: List[Tuple[float, float]]
    transcription: Optional[List[Dict]] = None

@app.get("/api/select-file", response_model=SelectFileResponse)
def select_file():
    """
    Abre un selector de archivos nativo en macOS utilizando AppleScript.
    """
    try:
        script = 'tell application "System Events" to activate\n' \
                 'tell application "System Events" to return POSIX path of (choose file with prompt "Selecciona el archivo a editar (Video o Audio):" of type {"public.movie", "public.video", "public.audio", "mp4", "mov", "mkv", "avi", "mp3", "wav", "m4a", "caf"})'
        
        result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
        
        if result.returncode == 0:
            path = result.stdout.strip()
            return {"path": path}
        else:
            raise HTTPException(status_code=400, detail="Selección de archivo cancelada por el usuario.")
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error al abrir el selector: {str(e)}")

@app.get("/api/select-folder", response_model=SelectFolderResponse)
def select_folder():
    """
    Abre un selector de carpetas nativo en macOS utilizando AppleScript.
    """
    try:
        script = 'tell application "System Events" to activate\n' \
                 'tell application "System Events" to return POSIX path of (choose folder with prompt "Selecciona la carpeta de destino:")'
        
        result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
        
        if result.returncode == 0:
            path = result.stdout.strip()
            return {"path": path}
        else:
            raise HTTPException(status_code=400, detail="Selección de carpeta cancelada por el usuario.")
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error al abrir el selector: {str(e)}")

def group_words_into_short_phrases(segments, max_words=6, max_pause=0.4):
    """
    Groups individual word timestamps into short, logical phrases (comma-separated, pause-separated, or max 6 words).
    This makes text-based editing much more precise.
    """
    short_phrases = []
    current_words = []
    
    for seg in segments:
        words = seg.get("words", [])
        if not words:
            short_phrases.append({
                "start": seg["start"],
                "end": seg["end"],
                "text": seg["text"].strip()
            })
            continue
            
        for w in words:
            word_text = w["word"]
            word_start = w["start"]
            word_end = w["end"]
            
            should_split = False
            
            if current_words:
                last_word = current_words[-1]
                pause = word_start - last_word["end"]
                
                if pause > max_pause:
                    should_split = True
                elif len(current_words) >= max_words:
                    should_split = True
                elif any(char in last_word["word"] for char in [".", ",", "?", "!", ";"]):
                    should_split = True
            
            if should_split and current_words:
                phrase_text = "".join((("" if i == 0 or x["word"].startswith(" ") else " ") + x["word"]) for i, x in enumerate(current_words)).strip()
                short_phrases.append({
                    "start": current_words[0]["start"],
                    "end": current_words[-1]["end"],
                    "text": phrase_text,
                    "words": list(current_words)
                })
                current_words = []
                
            current_words.append({
                "word": word_text,
                "start": word_start,
                "end": word_end
            })
            
    if current_words:
        phrase_text = "".join((("" if i == 0 or x["word"].startswith(" ") else " ") + x["word"]) for i, x in enumerate(current_words)).strip()
        short_phrases.append({
            "start": current_words[0]["start"],
            "end": current_words[-1]["end"],
            "text": phrase_text,
            "words": list(current_words)
        })
        
    return short_phrases

# Background task for analysis
def run_analysis_task(task_id: str, request: AnalyzeRequest):
    try:
        tasks_status[task_id] = {"status": "processing", "progress": 10, "message": "Analizando estructura del video..."}
        
        info = get_media_info(request.video_path)
        
        silences = []
        keep_padded = [(0.0, info["duration"])]
        
        tasks_status[task_id] = {"status": "processing", "progress": 30, "message": "Buscando silencios..."}
        silences = detect_silences(
            request.video_path,
            noise_threshold_db=request.noise_threshold_db,
            min_silence_len=request.min_silence_len
        )
        keep_raw = get_keep_segments(silences, info["duration"])
        keep_padded = pad_and_merge_segments(keep_raw, info["duration"], request.padding)
        
        transcription_data = None
        
        if request.run_whisper:
            tasks_status[task_id] = {"status": "processing", "progress": 50, "message": "Extrayendo audio para transcripción..."}
            
            # Extract temporary audio for Whisper (16kHz mono wav)
            temp_audio = f"/Users/carloscorderolizana/.gemini/antigravity/scratch/temp_{task_id}.wav"
            os.makedirs(os.path.dirname(temp_audio), exist_ok=True)
            
            # Extract command
            cmd = [
                FFMPEG_PATH, "-y",
                "-i", request.video_path,
                "-ar", "16000",
                "-ac", "1",
                "-c:a", "pcm_s16le",
                temp_audio
            ]
            subprocess.run(cmd, capture_output=True)
            
            if os.path.exists(temp_audio):
                tasks_status[task_id] = {"status": "processing", "progress": 70, "message": f"Transcribiendo con Whisper ({request.whisper_model})..."}
                
                # Import mlx-whisper inside the task to avoid blocking load times
                import mlx_whisper
                
                model_name = f"mlx-community/whisper-{request.whisper_model}-mlx"
                if request.whisper_model == "turbo":
                    model_name = "mlx-community/whisper-large-v3-turbo"
                    
                result = mlx_whisper.transcribe(temp_audio, path_or_hf_repo=model_name, word_timestamps=True)
                raw_segments = result.get("segments", [])
                transcription_data = group_words_into_short_phrases(raw_segments)
                
                # Clean up audio
                os.remove(temp_audio)
        
        tasks_status[task_id] = {
            "status": "completed",
            "progress": 100,
            "result": {
                "media_info": info,
                "silences": silences,
                "keep_segments": keep_padded,
                "transcription": transcription_data
            }
        }
    except Exception as e:
        tasks_status[task_id] = {
            "status": "failed",
            "error": str(e)
        }

@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze_video(request: AnalyzeRequest, background_tasks: BackgroundTasks):
    """
    Inicia la tarea de análisis de video y detección de silencios en segundo plano.
    """
    if not os.path.exists(request.video_path):
        raise HTTPException(status_code=404, detail="El archivo de video no existe.")
        
    task_id = str(uuid.uuid4())
    tasks_status[task_id] = {"status": "queued", "progress": 0, "message": "En cola..."}
    
    background_tasks.add_task(run_analysis_task, task_id, request)
    
    return {
        "status": "success",
        "task_id": task_id,
        "message": "Análisis iniciado en segundo plano."
    }

@app.get("/api/tasks/{task_id}")
def get_task_status(task_id: str):
    """
    Devuelve el estado actual de una tarea de análisis o exportación.
    """
    if task_id not in tasks_status:
        raise HTTPException(status_code=404, detail="Tarea no encontrada.")
    return tasks_status[task_id]

@app.post("/api/export")
def export_video(request: ExportRequest):
    """
    Exporta el video utilizando el formato y segmentos elegidos.
    """
    if not os.path.exists(request.video_path):
        raise HTTPException(status_code=404, detail="El archivo de video original no existe.")
        
    # Ensure export folder exists
    export_dir = os.path.dirname(request.output_path)
    if export_dir and not os.path.exists(export_dir):
        os.makedirs(export_dir, exist_ok=True)
        
    try:
        if request.export_format in ("mp4", "mov"):
            export_mp4_fast(request.video_path, request.segments, request.output_path)
        elif request.export_format == "xml":
            export_standard_xml(request.video_path, request.segments, request.output_path)
        elif request.export_format == "fcpxml":
            export_fcpxml(request.video_path, request.segments, request.output_path)
        else:
            raise HTTPException(status_code=400, detail="Formato de exportación no soportado.")
            
        return {
            "status": "success",
            "message": f"Exportación completada exitosamente en: {request.output_path}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error durante la exportación: {str(e)}")

from fastapi.responses import FileResponse

@app.get("/api/video")
def get_video(path: str):
    """
    Sirve un archivo de video local para poder reproducirlo en el navegador.
    """
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Video no encontrado.")
    return FileResponse(path)

@app.get("/")
def read_root():
    return {"message": "El backend del Editor de Video Inteligente está corriendo."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
