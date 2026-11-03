import React, { useState, useEffect, useRef } from "react";

const BACKEND_URL = "http://localhost:8000";

// Interval subtraction helper (1D segment subtraction)
const subtractIntervals = (intervals, exStart, exEnd) => {
  const result = [];
  for (const [start, end] of intervals) {
    if (exEnd <= start || exStart >= end) {
      // No overlap, keep interval as is
      result.push([start, end]);
    } else {
      // Overlap cases
      if (exStart > start) {
        // Keep left part
        result.push([start, exStart]);
      }
      if (exEnd < end) {
        // Keep right part
        result.push([exEnd, end]);
      }
    }
  }
  // Filter out extremely short fractions (e.g. less than 50ms)
  return result.filter(([start, end]) => (end - start) > 0.05);
};

export default function App() {
  // File state
  const [videoPath, setVideoPath] = useState("");
  const [videoName, setVideoName] = useState("");
  const [outputPath, setOutputPath] = useState("");

  // Process settings
  const [noiseThreshold, setNoiseThreshold] = useState(-30);
  const [minSilenceLen, setMinSilenceLen] = useState(0.5);
  const [padding, setPadding] = useState(0.2);

  // Operational and Whisper settings
  // Operational and Whisper settings
  const [whisperModel, setWhisperModel] = useState("base");

  // Calculated flag for convenience
  const runWhisper = true;

  // Export settings
  const [exportFormat, setExportFormat] = useState("mp4");

  // Task & Analysis State
  const [taskId, setTaskId] = useState(null);
  const [taskStatus, setTaskStatus] = useState(null);
  const [taskMessage, setTaskMessage] = useState("");
  const [taskProgress, setTaskProgress] = useState(0);

  // Loaded Media Info
  const [mediaInfo, setMediaInfo] = useState(null);
  const [silences, setSilences] = useState([]);
  
  // Advanced Text-based / Timeline States
  const [baseKeepSegments, setBaseKeepSegments] = useState([]); // Silence-based keeps
  const [transcription, setTranscription] = useState([]); // [{ start, end, text, excluded }]
  const [disabledTimelineSegmentIds, setDisabledTimelineSegmentIds] = useState(new Set());

  // UI state
  const [isDragging, setIsDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(null);
  const [exportError, setExportError] = useState(null);

  // Video element ref and current play time
  const videoRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);

  // --- Compute Current Segments dynamically ---
  // Start with silence keeps, subtract any excluded transcript sentences
  let currentKeep = baseKeepSegments.map(s => [s[0], s[1]]);
  transcription.forEach(item => {
    if (item.excluded) {
      currentKeep = subtractIntervals(currentKeep, item.start, item.end);
    }
  });

  // Convert to formatted segment structures for timeline
  const computedSegments = currentKeep.map(([start, end], idx) => ({
    id: idx,
    start,
    end,
    active: !disabledTimelineSegmentIds.has(idx),
  }));

  // Trigger select file from backend using native macOS chooser
  const handleSelectFile = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/select-file`);
      if (res.ok) {
        const data = await res.json();
        if (data.path) {
          setVideoPath(data.path);
          const name = data.path.split("/").pop();
          setVideoName(name);

          // Suggest same directory as output by default
          const lastSlash = data.path.lastIndexOf("/");
          if (lastSlash !== -1) {
            setOutputPath(data.path.substring(0, lastSlash));
          }
          
          // Reset analysis state for new video
          setMediaInfo(null);
          setBaseKeepSegments([]);
          setSilences([]);
          setTranscription([]);
          setDisabledTimelineSegmentIds(new Set());
          setTaskId(null);
          setTaskStatus(null);
        }
      }
    } catch (err) {
      console.error("Error al seleccionar archivo:", err);
    }
  };

  // Trigger select folder from backend using native macOS chooser
  const handleSelectFolder = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/select-folder`);
      if (res.ok) {
        const data = await res.json();
        if (data.path) {
          setOutputPath(data.path);
        }
      }
    } catch (err) {
      console.error("Error al seleccionar carpeta:", err);
    }
  };

  // Handle Drag & Drop (triggers select file for native confirmation)
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleSelectFile();
  };

  // Trigger Analysis
  const handleAnalyze = async () => {
    if (!videoPath) return;

    setTaskId(null);
    setTaskStatus("queued");
    setTaskProgress(0);
    setTaskMessage("Iniciando análisis...");
    setExportSuccess(null);
    setExportError(null);

    try {
      const res = await fetch(`${BACKEND_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_path: videoPath,
          run_whisper: runWhisper,
          whisper_model: whisperModel,
          noise_threshold_db: Number(noiseThreshold),
          min_silence_len: Number(minSilenceLen),
          padding: Number(padding),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setTaskId(data.task_id);
      } else {
        const errData = await res.json();
        setTaskStatus("failed");
        setTaskMessage(errData.detail || "Error en la petición de análisis.");
      }
    } catch (err) {
      setTaskStatus("failed");
      setTaskMessage("No se pudo conectar con el servidor.");
    }
  };

  // Poll Task Status
  useEffect(() => {
    if (!taskId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/tasks/${taskId}`);
        if (res.ok) {
          const data = await res.json();
          setTaskStatus(data.status);
          setTaskMessage(data.message || "");
          if (data.progress) setTaskProgress(data.progress);

          if (data.status === "completed") {
            clearInterval(interval);
            const result = data.result;
            setMediaInfo(result.media_info);
            setSilences(result.silences || []);
            setBaseKeepSegments(result.keep_segments || []);
            
            // Map transcription items with "excluded: false" initially
            const mappedTrans = (result.transcription || []).map(t => ({
              ...t,
              excluded: false
            }));
            setTranscription(mappedTrans);
            setDisabledTimelineSegmentIds(new Set());
          } else if (data.status === "failed") {
            clearInterval(interval);
            setTaskMessage(data.error || "El análisis falló.");
          }
        }
      } catch (err) {
        console.error("Error consultando estado de tarea:", err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [taskId]);

  // Handle Timeline Click (seeks video)
  const handleTimelineClick = (e) => {
    if (!mediaInfo || !videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * mediaInfo.duration;
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  // Toggle timeline segment (disabled/enabled)
  const toggleTimelineSegment = (id) => {
    setDisabledTimelineSegmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Toggle transcription segment (excluded/included)
  const toggleTranscriptionSegment = (idx) => {
    setTranscription((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, excluded: !item.excluded } : item))
    );
  };

  // Trigger Export
  const handleExport = async () => {
    if (!videoPath || !outputPath || computedSegments.length === 0) return;

    setExporting(true);
    setExportSuccess(null);
    setExportError(null);

    // Filter to send only active segment intervals to the backend
    const activeSegs = computedSegments.filter((s) => s.active).map((s) => [s.start, s.end]);

    if (activeSegs.length === 0) {
      setExportError("Debes seleccionar al menos un segmento activo para exportar.");
      setExporting(false);
      return;
    }

    let extension = ".mp4";
    if (exportFormat === "mov") extension = ".mov";
    if (exportFormat === "xml") extension = ".xml";
    if (exportFormat === "fcpxml") extension = ".fcpxml";

    const baseName = videoName.substring(0, videoName.lastIndexOf("."));
    const outputFileName = `${baseName}_cut${extension}`;
    const fullOutputPath = `${outputPath}/${outputFileName}`;

    try {
      const res = await fetch(`${BACKEND_URL}/api/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_path: videoPath,
          output_path: fullOutputPath,
          export_format: exportFormat,
          segments: activeSegs,
          transcription: transcription,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setExportSuccess(data.message);
      } else {
        const errData = await res.json();
        setExportError(errData.detail || "Error al exportar.");
      }
    } catch (err) {
      setExportError("Error de conexión al exportar.");
    } finally {
      setExporting(false);
    }
  };

  // Video time tracker
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [mediaInfo]);

  // Format time (s) -> mm:ss.d
  const formatTime = (timeSecs) => {
    const minutes = Math.floor(timeSecs / 60);
    const seconds = Math.floor(timeSecs % 60);
    const ms = Math.floor((timeSecs % 1) * 10);
    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}.${ms}`;
  };

  return (
    <div className="flex h-screen bg-neutral-950 text-white font-sans overflow-hidden">
      {/* Sidebar - Control Panel */}
      <aside className="w-80 bg-neutral-900 border-r border-neutral-800 flex flex-col justify-between shrink-0 overflow-y-auto">
        <div className="p-6 space-y-6">
          <div className="flex items-center space-x-2">
            <span className="text-2xl font-bold bg-gradient-to-r from-violet-400 to-indigo-500 bg-clip-text text-transparent">
              SmartEditor
            </span>
            <span className="text-xs bg-violet-600/30 text-violet-400 px-2 py-0.5 rounded-full border border-violet-500/20 font-medium">
              v1.1 TextCut
            </span>
          </div>

          <hr className="border-neutral-800" />

          {/* Video Selection */}
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Video de Origen
            </label>
            {videoPath ? (
              <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2 text-sm">
                <div className="font-semibold text-neutral-200 truncate">{videoName}</div>
                <div className="text-xs text-neutral-500 break-all">{videoPath}</div>
                <button
                  onClick={handleSelectFile}
                  className="text-xs text-violet-400 hover:text-violet-300 font-semibold flex items-center space-x-1"
                >
                  <span>Cambiar video</span>
                </button>
              </div>
            ) : (
              <button
                onClick={handleSelectFile}
                className="w-full py-4 border-2 border-dashed border-neutral-700 hover:border-violet-500/50 bg-neutral-950/40 hover:bg-neutral-900/40 rounded-lg flex flex-col items-center justify-center space-y-1 transition text-neutral-400"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l-4 4m0 0l-4-4m4 4V3m4 8h3a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
                </svg>
                <span className="text-xs font-semibold">Seleccionar Video</span>
              </button>
            )}
          </div>

          <div className="space-y-4">
                <label className="text-xs font-semibold uppercase tracking-wider text-neutral-400 block">
                  Configuración de Silencio
                </label>

                {/* Noise Threshold */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-neutral-300">
                    <span>Umbral de Ruido</span>
                    <span className="font-semibold">{noiseThreshold} dB</span>
                  </div>
                  <input
                    type="range"
                    min="-60"
                    max="0"
                    step="1"
                    value={noiseThreshold}
                    onChange={(e) => setNoiseThreshold(e.target.value)}
                    className="w-full accent-violet-500 h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-[10px] text-neutral-500">Valores bajos detectan solo silencio absoluto.</span>
                </div>

                {/* Min Silence Length */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-neutral-300">
                    <span>Duración Mínima</span>
                    <span className="font-semibold">{minSilenceLen}s</span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="2.0"
                    step="0.05"
                    value={minSilenceLen}
                    onChange={(e) => setMinSilenceLen(e.target.value)}
                    className="w-full accent-violet-500 h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                {/* Padding */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-neutral-300">
                    <span>Margen de Seguridad (Padding)</span>
                    <span className="font-semibold">{padding}s</span>
                  </div>
                  <input
                    type="range"
                    min="0.0"
                    max="1.0"
                    step="0.05"
                    value={padding}
                    onChange={(e) => setPadding(e.target.value)}
                    className="w-full accent-violet-500 h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-[10px] text-neutral-500">Evita que la voz se corte bruscamente.</span>
                </div>
              </div>

              <hr className="border-neutral-800" />
              {/* Whisper local */}
              <div className="space-y-3">
                <label className="text-xs font-semibold uppercase tracking-wider text-neutral-400 block">
                  Whisper IA Local (MLX)
                </label>
                <div className="space-y-2 bg-neutral-950 p-3 rounded-lg border border-neutral-800">
                  <label className="text-xs text-neutral-400 block">Modelo a utilizar:</label>
                  <select
                    value={whisperModel}
                    onChange={(e) => setWhisperModel(e.target.value)}
                    className="w-full text-xs bg-neutral-900 border border-neutral-700 rounded p-1.5 focus:outline-none focus:border-violet-500"
                  >
                    <option value="base">Base (Rápido)</option>
                    <option value="small">Small (Equilibrado)</option>
                    <option value="turbo">Turbo (Precisión)</option>
                  </select>
                  <span className="text-[9px] text-violet-400/80 block leading-tight">
                    Se ejecuta nativamente en el Neural Engine de tu Apple Silicon.
                  </span>
                </div>
              </div>

          {videoPath && (
            <button
              onClick={handleAnalyze}
              disabled={taskStatus === "processing" || taskStatus === "queued"}
              className={`w-full py-2.5 rounded-lg font-semibold text-sm transition flex items-center justify-center space-x-2 ${
                taskStatus === "processing" || taskStatus === "queued"
                  ? "bg-neutral-800 text-neutral-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-500/20"
              }`}
            >
              {taskStatus === "processing" || taskStatus === "queued" ? (
                <>
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>
                    Procesando ({taskProgress}%)
                  </span>
                </>
              ) : (
                  <span>
                    Cortar y Transcribir
                  </span>
              )}
            </button>
          )}
        </div>

        {/* System Diagnostics Info / Footer */}
        <div className="p-6 bg-neutral-950 border-t border-neutral-800 text-xs text-neutral-500 space-y-1">
          <div>OS: macOS Apple Silicon</div>
          <div>Audio Engine: FFmpeg GPU Accel</div>
          <div>Text Edit: Sentence Subtraction</div>
        </div>
      </aside>

      {/* Main Workspace */}
      <main className="flex-1 flex flex-col overflow-hidden bg-neutral-950">
        {!mediaInfo ? (
          /* Empty Workspace / Upload Landing */
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleSelectFile}
              className={`w-full max-w-2xl aspect-video rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-12 text-center cursor-pointer transition-all duration-300 relative overflow-hidden group ${
                isDragging
                  ? "border-violet-500 bg-violet-500/5"
                  : "border-neutral-800 hover:border-neutral-700 bg-neutral-900/30 hover:bg-neutral-900/40"
              }`}
            >
              {/* Decorative Glow */}
              <div className="absolute -inset-x-20 -inset-y-20 bg-violet-600/5 rounded-full filter blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

              <div className="space-y-4 max-w-sm relative z-10">
                <div className="mx-auto w-16 h-16 bg-neutral-900 border border-neutral-800 rounded-2xl flex items-center justify-center shadow-lg group-hover:scale-110 transition duration-300">
                  <svg className="w-8 h-8 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                <div className="space-y-1">
                  <h3 className="text-lg font-bold">Importa tu archivo de video</h3>
                  <p className="text-sm text-neutral-400">
                    Arrastra tu video desde el Finder de macOS o haz clic en cualquier zona de esta tarjeta.
                  </p>
                </div>
                {videoPath && (
                  <div className="pt-2">
                    <div className="text-xs bg-violet-500/10 text-violet-400 px-3 py-1.5 rounded-full inline-block font-semibold border border-violet-500/10">
                      Archivo cargado: {videoName}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Analysis State Alert */}
            {taskStatus && taskStatus !== "completed" && (
              <div className="mt-8 w-full max-w-xl bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold text-neutral-300">Estado del Análisis</span>
                  <span className="text-xs uppercase bg-neutral-800 px-2 py-0.5 rounded text-neutral-400 font-bold">
                    {taskStatus}
                  </span>
                </div>
                <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-500 transition-all duration-300"
                    style={{ width: `${taskProgress}%` }}
                  />
                </div>
                <p className="text-xs text-neutral-400 italic">{taskMessage}</p>
              </div>
            )}
          </div>
        ) : (
          /* Editor Interface */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Upper Workspace: Video Player + Interactive Transcription */}
            <div className="flex-1 flex min-h-0 border-b border-neutral-800">
              {/* Left Side: Video Preview */}
              <div className="flex-1 flex flex-col justify-center items-center p-6 bg-neutral-950 relative">
                <div className="w-full max-w-4xl aspect-video rounded-xl overflow-hidden bg-black border border-neutral-800 shadow-2xl relative">
                  <video
                    ref={videoRef}
                    src={`${BACKEND_URL}/api/video?path=${encodeURIComponent(videoPath)}`}
                    controls
                    className="w-full h-full object-contain"
                  />
                  {mediaInfo && !mediaInfo.has_video && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 pointer-events-none">
                      <svg className="w-16 h-16 text-violet-500 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                      </svg>
                      <span className="mt-2 text-sm text-neutral-400 font-medium">Archivo de Audio</span>
                    </div>
                  )}
                </div>
                <div className="mt-4 flex space-x-6 text-sm text-neutral-400">
                  {mediaInfo && mediaInfo.has_video ? (
                    <>
                      <div>
                        FPS: <span className="font-semibold text-white">{mediaInfo.fps.toFixed(2)}</span>
                      </div>
                      <div>
                        Resolución:{" "}
                        <span className="font-semibold text-white">
                          {mediaInfo.width}x{mediaInfo.height}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div>
                      Tipo: <span className="font-semibold text-white">Audio</span>
                    </div>
                  )}
                  <div>
                    Duración Original:{" "}
                    <span className="font-semibold text-white">
                      {formatTime(mediaInfo.duration)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Side: Whisper Transcription (Interactive Text Editor) */}
              {runWhisper && transcription.length > 0 && (
                <div className="w-80 border-l border-neutral-800 bg-neutral-900/30 flex flex-col overflow-hidden">
                  <div className="p-4 border-b border-neutral-800 bg-neutral-900/50 flex flex-col space-y-1">
                    <h3 className="text-sm font-bold flex items-center space-x-2 text-neutral-200">
                      <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
                      <span>Edición por Texto</span>
                    </h3>
                    <p className="text-[10px] text-neutral-500 leading-tight">
                      Tacha diálogos para recortarlos del video final.
                    </p>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {transcription.map((seg, idx) => (
                      <div
                        key={idx}
                        className={`p-2.5 rounded-lg border transition relative group ${
                          seg.excluded
                            ? "border-rose-950/40 bg-rose-950/5 text-neutral-500"
                            : "border-neutral-800 bg-neutral-950/40 hover:bg-neutral-800/20 text-neutral-200"
                        }`}
                      >
                        {/* Exclude/Include button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTranscriptionSegment(idx);
                          }}
                          className={`absolute top-2 right-2 p-1 rounded transition opacity-0 group-hover:opacity-100 ${
                            seg.excluded
                              ? "bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                              : "bg-rose-600/20 text-rose-400 hover:bg-rose-600/30"
                          }`}
                          title={seg.excluded ? "Restaurar frase" : "Excluir frase del video"}
                        >
                          {seg.excluded ? (
                            // Eye Open / Restore Icon
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          ) : (
                            // Trash Icon
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          )}
                        </button>

                        {/* Content text */}
                        <div
                          onClick={() => {
                            if (videoRef.current) videoRef.current.currentTime = seg.start;
                          }}
                          className="cursor-pointer space-y-1.5 pr-6"
                        >
                          <div className="flex justify-between text-neutral-500 font-mono text-[9px] font-semibold">
                            <span>{formatTime(seg.start)}</span>
                            <span>{formatTime(seg.end)}</span>
                          </div>
                          <p className={`text-xs leading-relaxed transition-all duration-200 ${seg.excluded ? "line-through opacity-40 italic" : ""}`}>
                            {seg.text}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Interactive Timeline */}
            <div className="p-6 bg-neutral-900 border-b border-neutral-800 space-y-4">
              <div className="flex items-center justify-between text-xs text-neutral-400">
                <div className="flex items-center space-x-2">
                  <span className="font-bold text-neutral-200">Línea de Tiempo Interactiva</span>
                  <span>•</span>
                  <span>Haz clic en los bloques verdes para desactivar tomas</span>
                </div>
                <div className="font-mono text-neutral-300">
                  <span className="text-violet-400 font-bold">{formatTime(currentTime)}</span> /{" "}
                  {formatTime(mediaInfo.duration)}
                </div>
              </div>

              {/* Waveform/Timeline Blocks */}
              <div className="relative h-20 bg-neutral-950 rounded-xl border border-neutral-800 overflow-hidden select-none">
                {/* Visual Block Segments */}
                <div className="absolute inset-0 flex">
                  {computedSegments.length === 0 && (
                    <div className="h-full w-full bg-rose-500/10 flex items-center justify-center text-xs text-rose-400 font-semibold">
                      No quedan segmentos activos para reproducir o exportar.
                    </div>
                  )}

                  {computedSegments.map((seg) => {
                    const widthPercent = ((seg.end - seg.start) / mediaInfo.duration) * 100;
                    const leftPercent = (seg.start / mediaInfo.duration) * 100;

                    return (
                      <div
                        key={seg.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleTimelineSegment(seg.id);
                        }}
                        style={{
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                        }}
                        className={`absolute h-full border-r border-neutral-900/40 flex flex-col justify-between p-1.5 transition cursor-pointer ${
                          seg.active
                            ? "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border-l border-emerald-500/30"
                            : "bg-neutral-800/40 hover:bg-neutral-700/40 text-neutral-500 border-l border-neutral-700"
                        }`}
                      >
                        <span className="text-[10px] font-bold truncate">Toma {seg.id + 1}</span>
                        <span className="text-[9px] font-mono opacity-80">
                          {(seg.end - seg.start).toFixed(1)}s
                        </span>
                      </div>
                    );
                  })}

                  {/* Silences visualization */}
                  {silences.map((sil, idx) => {
                    const widthPercent = ((sil[1] - sil[0]) / mediaInfo.duration) * 100;
                    const leftPercent = (sil[0] / mediaInfo.duration) * 100;

                    return (
                      <div
                        key={`sil-${idx}`}
                        style={{
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                        }}
                        className="absolute h-full bg-rose-500/10 border-l border-r border-rose-500/20 pointer-events-none flex items-center justify-center"
                      >
                        <span className="text-[8px] text-rose-400/50 font-mono rotate-90 sm:rotate-0">
                          {((sil[1] - sil[0])).toFixed(1)}s
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Hotspot for seeking */}
                <div
                  className="absolute inset-0 z-10 cursor-ew-resize bg-transparent"
                  onClick={(e) => handleTimelineClick(e)}
                />

                {/* Playhead Tracker Line */}
                {computedSegments.length > 0 && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-violet-400 z-20 pointer-events-none"
                    style={{
                      left: `${(currentTime / mediaInfo.duration) * 100}%`,
                      boxShadow: "0 0 8px 1px rgb(167 139 250)",
                    }}
                  />
                )}
              </div>

              {/* Timeline Legend */}
              <div className="flex space-x-6 text-[10px] text-neutral-400">
                <div className="flex items-center space-x-1.5">
                  <div className="w-2.5 h-2.5 bg-emerald-500/20 border border-emerald-500/30 rounded" />
                  <span>Segmento Activo (Se conserva)</span>
                </div>
                <div className="flex items-center space-x-1.5">
                  <div className="w-2.5 h-2.5 bg-neutral-800 border border-neutral-700 rounded" />
                  <span>Excluido/Desactivado</span>
                </div>
                <div className="flex items-center space-x-1.5">
                  <div className="w-2.5 h-2.5 bg-rose-500/10 border border-rose-500/20 rounded" />
                  <span>Silencio Eliminado</span>
                </div>
              </div>
            </div>

            {/* Export Bottom Panel */}
            <div className="p-6 bg-neutral-950 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-t border-neutral-900 shrink-0">
              {/* Left Side: Destination details */}
              <div className="space-y-1.5 flex-1 min-w-0">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400 block">
                  Destino de Exportación
                </span>
                <div className="flex items-center space-x-3">
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-2 flex-1 min-w-0 text-xs text-neutral-400 break-all truncate">
                    {outputPath || "Ninguna carpeta seleccionada"}
                  </div>
                  <button
                    onClick={handleSelectFolder}
                    className="px-3 py-2 bg-neutral-900 border border-neutral-800 hover:border-neutral-700 rounded-lg text-xs font-bold transition flex items-center space-x-1.5"
                  >
                    <svg className="w-4 h-4 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <span>Examinar</span>
                  </button>
                </div>
              </div>

              {/* Right Side: Options & Button */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-4 shrink-0">
                {/* Format selection */}
                <div className="space-y-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400 block">
                    Formato
                  </span>
                  <div className="flex bg-neutral-900 border border-neutral-800 rounded-lg p-0.5">
                    <button
                      onClick={() => setExportFormat("mp4")}
                      className={`px-3 py-1.5 rounded-md text-xs font-bold transition ${
                        exportFormat === "mp4" ? "bg-violet-600 text-white" : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      MP4
                    </button>
                    <button
                      onClick={() => setExportFormat("mov")}
                      className={`px-3 py-1.5 rounded-md text-xs font-bold transition ${
                        exportFormat === "mov" ? "bg-violet-600 text-white" : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      MOV
                    </button>
                    <button
                      onClick={() => setExportFormat("fcpxml")}
                      className={`px-3 py-1.5 rounded-md text-xs font-bold transition ${
                        exportFormat === "fcpxml" ? "bg-violet-600 text-white" : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      FCPXML
                    </button>
                    <button
                      onClick={() => setExportFormat("xml")}
                      className={`px-3 py-1.5 rounded-md text-xs font-bold transition ${
                        exportFormat === "xml" ? "bg-violet-600 text-white" : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      XML Estándar
                    </button>
                  </div>
                </div>

                {/* Export Button */}
                <div className="self-end">
                  <button
                    onClick={handleExport}
                    disabled={exporting}
                    className="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-lg text-sm shadow-lg shadow-emerald-500/10 hover:shadow-emerald-500/20 transition flex items-center justify-center space-x-2"
                  >
                    {exporting ? (
                      <>
                        <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span>Exportando...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8m-5 5h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 00.707.293h3.172a1 1 0 00.707-.293l2.414-2.414a1 1 0 01.707-.293H20" />
                        </svg>
                        <span>Procesar y Guardar</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Notification messages */}
            {(exportSuccess || exportError) && (
              <div className="px-6 pb-6 shrink-0">
                {exportSuccess && (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-3 rounded-lg text-xs font-semibold">
                    {exportSuccess}
                  </div>
                )}
                {exportError && (
                  <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 p-3 rounded-lg text-xs font-semibold">
                    {exportError}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
