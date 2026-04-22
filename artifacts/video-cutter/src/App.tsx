import { useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  Music,
  Video,
  Scissors,
  Download,
  CheckCircle2,
  Loader2,
  FileAudio,
  FileVideo,
  Sparkles,
  RefreshCw,
} from "lucide-react";

const FFMPEG_BASE_URL =
  "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";

function formatSeconds(s: number): string {
  if (!isFinite(s) || s < 0) return "0.00s";
  return `${s.toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getMediaDuration(file: File, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind) as HTMLMediaElement;
    el.preload = "metadata";
    (el as HTMLVideoElement).muted = true;
    const url = URL.createObjectURL(file);
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.src = "";
      el.removeAttribute("src");
      try {
        el.load();
      } catch {}
    };
    const finish = (d: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!isFinite(d) || d <= 0) {
        reject(new Error(`Could not read duration of ${kind} file`));
      } else {
        resolve(d);
      }
    };

    el.onloadedmetadata = () => {
      const d = el.duration;
      if (isFinite(d) && d > 0) {
        finish(d);
        return;
      }
      // Workaround for browsers reporting Infinity (e.g. some webm/mp4 files).
      // Seek to a very large time to force the browser to compute the real duration.
      const onTimeUpdate = () => {
        el.ontimeupdate = null;
        const real = el.duration;
        try {
          el.currentTime = 0;
        } catch {}
        finish(real);
      };
      el.ontimeupdate = onTimeUpdate;
      try {
        el.currentTime = 1e9;
      } catch {
        finish(NaN);
      }
    };
    el.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to load ${kind} file`));
    };

    // Safety timeout so we don't hang forever
    setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Timed out reading duration of ${kind} file`));
      }
    }, 15000);

    el.src = url;
  });
}

type Stage =
  | "idle"
  | "loading-ffmpeg"
  | "reading"
  | "cutting"
  | "done"
  | "error";

function VideoCutter() {
  const { toast } = useToast();
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(true);

  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string>("");
  const [outputSize, setOutputSize] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Load ffmpeg once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ffmpeg = new FFmpeg();
        ffmpeg.on("progress", ({ progress }) => {
          setProgress(Math.min(100, Math.max(0, Math.round(progress * 100))));
        });
        const coreURL = await toBlobURL(
          `${FFMPEG_BASE_URL}/ffmpeg-core.js`,
          "text/javascript",
        );
        const wasmURL = await toBlobURL(
          `${FFMPEG_BASE_URL}/ffmpeg-core.wasm`,
          "application/wasm",
        );
        await ffmpeg.load({ coreURL, wasmURL });
        if (cancelled) return;
        ffmpegRef.current = ffmpeg;
        setFfmpegReady(true);
        setFfmpegLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setFfmpegLoading(false);
        setErrorMsg("Failed to load video engine. Please refresh.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAudio = async (file: File | null) => {
    setAudioFile(file);
    setAudioDuration(null);
    if (!file) return;
    try {
      const d = await getMediaDuration(file, "audio");
      setAudioDuration(d);
    } catch (e) {
      toast({
        title: "Audio read error",
        description: (e as Error).message,
        variant: "destructive",
      });
      setAudioFile(null);
    }
  };

  const handleVideo = async (file: File | null) => {
    setVideoFile(file);
    setVideoDuration(null);
    if (!file) return;
    try {
      const d = await getMediaDuration(file, "video");
      setVideoDuration(d);
    } catch (e) {
      toast({
        title: "Video read error",
        description: (e as Error).message,
        variant: "destructive",
      });
      setVideoFile(null);
    }
  };

  const cutTime =
    audioDuration !== null && videoDuration !== null
      ? audioDuration - videoDuration
      : null;

  const canCut =
    ffmpegReady &&
    !!audioFile &&
    !!videoFile &&
    cutTime !== null &&
    cutTime > 0 &&
    videoDuration !== null &&
    cutTime < videoDuration &&
    stage !== "cutting" &&
    stage !== "reading";

  const reset = () => {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setOutputUrl(null);
    setOutputName("");
    setOutputSize(0);
    setAudioFile(null);
    setVideoFile(null);
    setAudioDuration(null);
    setVideoDuration(null);
    setStage("idle");
    setProgress(0);
    setErrorMsg("");
  };

  const handleCut = async () => {
    if (!ffmpegRef.current || !audioFile || !videoFile || cutTime === null)
      return;
    const ffmpeg = ffmpegRef.current;
    setErrorMsg("");
    setProgress(0);
    setOutputUrl(null);

    const ext = (videoFile.name.split(".").pop() || "mp4").toLowerCase();
    const inputName = `input.${ext}`;
    const outputExt = ext === "mov" || ext === "mkv" || ext === "webm" ? ext : "mp4";
    const outputName = `Clip 2.${outputExt}`;

    try {
      setStage("reading");
      const data = await fetchFile(videoFile);
      await ffmpeg.writeFile(inputName, data);

      // Cut the LAST `cutTime` seconds of the video.
      // start = videoDuration - cutTime
      const startSec = (videoDuration as number) - cutTime;

      setStage("cutting");
      // Stream copy (no re-encode) — preserves original quality, resolution,
      // frame rate, and speed. Codec copy keeps it fast and lossless.
      // -ss before -i for fast seek; with -c copy this snaps to keyframes.
      await ffmpeg.exec([
        "-ss",
        startSec.toFixed(3),
        "-i",
        inputName,
        "-c",
        "copy",
        "-an",
        "-avoid_negative_ts",
        "make_zero",
        outputName,
      ]);

      const out = await ffmpeg.readFile(outputName);
      const outBuf = out as Uint8Array;
      const blob = new Blob([outBuf.slice().buffer], {
        type: outputExt === "webm" ? "video/webm" : "video/mp4",
      });
      const url = URL.createObjectURL(blob);
      setOutputUrl(url);
      setOutputName(outputName);
      setOutputSize(blob.size);
      setStage("done");
      setProgress(100);

      // cleanup virtual fs
      try {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.error(e);
      setStage("error");
      setErrorMsg(
        (e as Error).message ||
          "Cutting failed. Try a different video format.",
      );
    }
  };

  const isWorking = stage === "reading" || stage === "cutting";

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-6 py-12">
        {/* Header */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-1.5 text-xs font-medium text-indigo-300">
            <Sparkles className="h-3.5 w-3.5" />
            Browser-based · No upload to server · Lossless cut
          </div>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            Video Clip Cutter
          </h1>
          <p className="mt-3 text-base text-slate-400">
            Upload audio + video. We measure the gap, cut the tail off your
            video, and hand you the clip — same quality, same speed, zero
            re-encoding.
          </p>
          {ffmpegLoading && (
            <div className="mt-4 inline-flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading video engine...
            </div>
          )}
          {!ffmpegLoading && ffmpegReady && (
            <div className="mt-4 inline-flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Engine ready
            </div>
          )}
        </div>

        {/* Upload grid */}
        <div className="grid gap-5 md:grid-cols-2">
          <UploadCard
            kind="audio"
            file={audioFile}
            duration={audioDuration}
            onChange={handleAudio}
            disabled={isWorking}
          />
          <UploadCard
            kind="video"
            file={videoFile}
            duration={videoDuration}
            onChange={handleVideo}
            disabled={isWorking}
          />
        </div>

        {/* Calculation panel */}
        <Card className="mt-6 border-slate-800 bg-slate-900/60 backdrop-blur">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
              <Scissors className="h-4 w-4 text-indigo-400" />
              Auto Cut Calculation
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Stat
                label="Audio time"
                value={audioDuration !== null ? formatSeconds(audioDuration) : "—"}
                tone="emerald"
              />
              <Stat
                label="Video time"
                value={videoDuration !== null ? formatSeconds(videoDuration) : "—"}
                tone="rose"
              />
              <Stat
                label="Cutting time"
                value={cutTime !== null ? formatSeconds(cutTime) : "—"}
                tone={
                  cutTime === null
                    ? "slate"
                    : cutTime > 0 && cutTime < (videoDuration ?? Infinity)
                      ? "indigo"
                      : "amber"
                }
                hint="Last N seconds of the video"
              />
            </div>

            {audioDuration !== null && videoDuration !== null && (
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 font-mono text-xs text-slate-400">
                {formatSeconds(audioDuration)} − {formatSeconds(videoDuration)} ={" "}
                <span className="text-slate-200">
                  {formatSeconds(cutTime ?? 0)}
                </span>
                {cutTime !== null && cutTime <= 0 && (
                  <span className="ml-2 text-amber-400">
                    · Audio must be longer than video
                  </span>
                )}
                {cutTime !== null &&
                  videoDuration !== null &&
                  cutTime >= videoDuration && (
                    <span className="ml-2 text-amber-400">
                      · Cut time can't exceed video length
                    </span>
                  )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                onClick={handleCut}
                disabled={!canCut}
                className="bg-indigo-500 text-white hover:bg-indigo-400 disabled:opacity-40"
                data-testid="button-cut"
              >
                {isWorking ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {stage === "reading" ? "Reading video..." : "Cutting..."}
                  </>
                ) : (
                  <>
                    <Scissors className="mr-2 h-4 w-4" />
                    Auto Cut
                  </>
                )}
              </Button>
              {(audioFile || videoFile || outputUrl) && !isWorking && (
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={reset}
                  className="text-slate-300 hover:text-white"
                  data-testid="button-reset"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Reset
                </Button>
              )}
            </div>

            {isWorking && (
              <div className="mt-5">
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-2 text-right text-xs text-slate-400">
                  {progress}%
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                {errorMsg}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Output */}
        {outputUrl && (
          <Card className="mt-6 border-emerald-500/30 bg-emerald-500/5">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                Output Video Ready
              </div>
              <div className="mt-4 w-1/4 overflow-hidden rounded-lg border border-slate-800 bg-black">
                <video
                  src={outputUrl}
                  controls
                  className="h-auto w-full"
                  data-testid="video-output"
                />
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-slate-400">
                  <span className="text-slate-200">{outputName}</span>
                  <span className="mx-2 text-slate-600">·</span>
                  {formatBytes(outputSize)}
                  <span className="mx-2 text-slate-600">·</span>
                  {formatSeconds(cutTime ?? 0)}
                </div>
                <a href={outputUrl} download={outputName}>
                  <Button
                    className="bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                    data-testid="button-download"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download Clip
                  </Button>
                </a>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Footer */}
        <div className="mt-12 text-center text-xs text-slate-500">
          Files never leave your device. Processing happens entirely in your
          browser.
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: "emerald" | "rose" | "indigo" | "slate" | "amber";
  hint?: string;
}) {
  const toneMap: Record<string, string> = {
    emerald: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
    rose: "border-rose-500/30 bg-rose-500/5 text-rose-300",
    indigo: "border-indigo-500/30 bg-indigo-500/5 text-indigo-300",
    slate: "border-slate-700 bg-slate-800/40 text-slate-400",
    amber: "border-amber-500/30 bg-amber-500/5 text-amber-300",
  };
  return (
    <div className={`rounded-lg border px-4 py-3 ${toneMap[tone]}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-70">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
      {hint && <div className="mt-1 text-[10px] opacity-60">{hint}</div>}
    </div>
  );
}

function UploadCard({
  kind,
  file,
  duration,
  onChange,
  disabled,
}: {
  kind: "audio" | "video";
  file: File | null;
  duration: number | null;
  onChange: (f: File | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const accent =
    kind === "audio"
      ? {
          ring: "border-emerald-500/40 hover:border-emerald-500/70",
          bg: "bg-emerald-500/5",
          icon: "text-emerald-400",
          chip: "bg-emerald-500/15 text-emerald-300",
        }
      : {
          ring: "border-rose-500/40 hover:border-rose-500/70",
          bg: "bg-rose-500/5",
          icon: "text-rose-400",
          chip: "bg-rose-500/15 text-rose-300",
        };

  const Icon = kind === "audio" ? Music : Video;
  const FileIcon = kind === "audio" ? FileAudio : FileVideo;
  const accept = kind === "audio" ? "audio/*" : "video/*";

  return (
    <div
      className={`group relative cursor-pointer rounded-xl border-2 border-dashed p-6 transition-colors ${accent.ring} ${accent.bg} ${
        disabled ? "pointer-events-none opacity-50" : ""
      }`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onChange(f);
      }}
      data-testid={`upload-${kind}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        data-testid={`input-${kind}`}
      />
      <div className="flex items-start gap-4">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-900 ${accent.icon}`}
        >
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
              {kind === "audio" ? "Audio Upload" : "Video Upload"}
            </h3>
            {duration !== null && (
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${accent.chip}`}
              >
                {formatSeconds(duration)}
              </span>
            )}
          </div>
          {file ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-slate-300">
              <FileIcon className="h-4 w-4 text-slate-500" />
              <span className="truncate" data-testid={`text-${kind}-name`}>
                {file.name}
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-xs text-slate-500">
                {formatBytes(file.size)}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <Upload className="h-3.5 w-3.5" />
                Click or drop a file here
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <TooltipProvider>
      <VideoCutter />
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
