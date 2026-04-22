import { useEffect, useMemo, useRef, useState } from "react";
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
  ArrowRight,
  Play,
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
  const videoUrl = useMemo(
    () => (videoFile ? URL.createObjectURL(videoFile) : null),
    [videoFile],
  );
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);
  const [outputName, setOutputName] = useState<string>("");
  const [outputSize, setOutputSize] = useState<number>(0);
  const [mergedUrl, setMergedUrl] = useState<string | null>(null);
  const [mergedName, setMergedName] = useState<string>("");
  const [mergedSize, setMergedSize] = useState<number>(0);
  const [mergedDuration, setMergedDuration] = useState<number>(0);
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
    if (mergedUrl) URL.revokeObjectURL(mergedUrl);
    setOutputUrl(null);
    setOutputName("");
    setOutputSize(0);
    setMergedUrl(null);
    setMergedName("");
    setMergedSize(0);
    setMergedDuration(0);
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
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    if (mergedUrl) URL.revokeObjectURL(mergedUrl);
    setOutputUrl(null);
    setMergedUrl(null);

    const ext = (videoFile.name.split(".").pop() || "mp4").toLowerCase();
    const inputName = `input.${ext}`;
    const outputExt = ext === "mov" || ext === "mkv" || ext === "webm" ? ext : "mp4";
    const outputName = `Clip 2.${outputExt}`;
    const clip1NoAudio = `clip1.${outputExt}`;
    const mergedFileName = `Merged.${outputExt}`;

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
      const mimeType = outputExt === "webm" ? "video/webm" : "video/mp4";
      const blob = new Blob([outBuf.slice().buffer], { type: mimeType });
      const url = URL.createObjectURL(blob);
      setOutputUrl(url);
      setOutputName(outputName);
      setOutputSize(blob.size);

      // Now build merged video: clip1 (without audio) + clip2, lossless concat.
      await ffmpeg.exec([
        "-i",
        inputName,
        "-c",
        "copy",
        "-an",
        clip1NoAudio,
      ]);

      const concatList = `file '${clip1NoAudio}'\nfile '${outputName}'\n`;
      await ffmpeg.writeFile(
        "concat.txt",
        new TextEncoder().encode(concatList),
      );

      await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "concat.txt",
        "-c",
        "copy",
        mergedFileName,
      ]);

      const mergedData = await ffmpeg.readFile(mergedFileName);
      const mergedBuf = mergedData as Uint8Array;
      const mergedBlob = new Blob([mergedBuf.slice().buffer], {
        type: mimeType,
      });
      const mUrl = URL.createObjectURL(mergedBlob);
      setMergedUrl(mUrl);
      setMergedName(mergedFileName);
      setMergedSize(mergedBlob.size);
      setMergedDuration((videoDuration as number) + cutTime);

      setStage("done");
      setProgress(100);

      // cleanup virtual fs
      try {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
        await ffmpeg.deleteFile(clip1NoAudio);
        await ffmpeg.deleteFile(mergedFileName);
        await ffmpeg.deleteFile("concat.txt");
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
      <div className="mx-auto max-w-7xl px-6 py-12">
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

        {/* Diagram-style flow: uploads → AUTO CUT → clips → merged */}
        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.1fr)]">
          {/* 1. Stacked uploads */}
          <div className="flex flex-col justify-center gap-5">
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

          <FlowArrow />

          {/* 2. AUTO CUT */}
          <div className="flex flex-col items-center justify-center gap-3">
            <button
              onClick={handleCut}
              disabled={!canCut}
              data-testid="button-cut"
              className="group relative w-full rounded-lg border-2 border-cyan-400 bg-gradient-to-br from-cyan-500/10 to-cyan-500/5 px-6 py-5 text-base font-semibold tracking-widest text-cyan-200 shadow-[0_0_30px_-10px_rgba(34,211,238,0.6)] transition hover:from-cyan-400/20 hover:to-cyan-500/10 hover:shadow-[0_0_40px_-8px_rgba(34,211,238,0.8)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {isWorking ? (
                <span className="inline-flex items-center">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {stage === "reading" ? "READING..." : "CUTTING..."}
                </span>
              ) : (
                <span className="inline-flex items-center">
                  <Scissors className="mr-2 h-4 w-4" />
                  AUTO CUT
                </span>
              )}
            </button>
            {cutTime !== null && cutTime > 0 && (
              <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2.5 py-1 font-mono text-[11px] text-cyan-300">
                trim −{formatSeconds(cutTime)}
              </div>
            )}
            {(audioFile || videoFile || outputUrl) && !isWorking && (
              <Button
                size="sm"
                variant="ghost"
                onClick={reset}
                className="text-slate-300 hover:text-white"
                data-testid="button-reset"
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Reset
              </Button>
            )}
          </div>

          <FlowArrow />

          {/* 3. Stacked clip boxes */}
          <div className="flex flex-col justify-center gap-5 invisible">
            <ClipBox
              label="CLIP 1"
              testId="video-main"
              videoUrl={videoUrl}
              fileName={videoFile?.name}
              fileSize={videoFile?.size ?? null}
              duration={videoDuration}
              downloadUrl={videoUrl}
              downloadName={videoFile?.name}
            />
            <ClipBox
              label="CLIP 2"
              testId="video-output"
              videoUrl={outputUrl}
              fileName={outputName || null}
              fileSize={outputSize || null}
              duration={cutTime}
              downloadUrl={outputUrl}
              downloadName={outputName}
            />
          </div>

          <FlowArrow />

          {/* 4. Merged Video */}
          <div className="flex flex-col justify-center">
            <div className="rounded-lg border-2 border-slate-200/70 bg-slate-900/40 p-3 shadow-[0_0_30px_-15px_rgba(148,163,184,0.6)]">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold tracking-wide text-slate-100">
                  Merged Video
                </div>
                <Sparkles className="h-3.5 w-3.5 text-purple-300" />
              </div>
              <div className="text-[11px] uppercase tracking-wider text-slate-400">
                Clip 1 + Clip 2
              </div>
              <div className="mt-3">
                <PlayablePreview
                  videoUrl={mergedUrl}
                  testId="video-merged"
                  emptyText="Result appears after Auto Cut"
                />
              </div>
              {mergedUrl && (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
                    <span className="truncate text-slate-300">{mergedName}</span>
                    <span className="text-slate-600">·</span>
                    <span>{formatBytes(mergedSize)}</span>
                    <span className="text-slate-600">·</span>
                    <span>{formatSeconds(mergedDuration)}</span>
                  </div>
                  <a
                    href={mergedUrl}
                    download={mergedName}
                    className="mt-3 inline-block w-full"
                  >
                    <Button
                      className="w-full bg-purple-500 text-white hover:bg-purple-400"
                      data-testid="button-download-merged"
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Download
                    </Button>
                  </a>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Progress + error */}
        {(isWorking || errorMsg) && (
          <Card className="mt-6 border-slate-800 bg-slate-900/60 backdrop-blur">
            <CardContent className="p-6">
              {isWorking && (
                <div>
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

function PlayablePreview({
  videoUrl,
  testId,
  emptyText = "Empty",
}: {
  videoUrl: string | null;
  testId: string;
  emptyText?: string;
}) {
  const [playing, setPlaying] = useState(false);

  if (!videoUrl) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded border border-slate-800 bg-black text-xs text-slate-600">
        {emptyText}
      </div>
    );
  }

  if (playing) {
    return (
      <video
        src={videoUrl}
        controls
        autoPlay
        className="aspect-video w-full rounded border border-slate-800 bg-black"
        data-testid={testId}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      className="group relative flex aspect-video w-full items-center justify-center rounded border border-slate-800 bg-black transition hover:border-slate-600"
      data-testid={`${testId}-play`}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 backdrop-blur transition group-hover:scale-110 group-hover:bg-white/20">
        <Play className="ml-0.5 h-5 w-5 fill-white text-white" />
      </span>
    </button>
  );
}

function FlowArrow() {
  return (
    <div className="hidden items-center justify-center lg:flex">
      <div className="relative flex items-center">
        <div className="h-px w-8 bg-gradient-to-r from-slate-700 to-slate-500" />
        <ArrowRight className="-ml-1 h-5 w-5 text-slate-400" />
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

function ClipBox({
  label,
  testId,
  videoUrl,
  fileName,
  fileSize,
  duration,
  downloadUrl,
  downloadName,
}: {
  label: string;
  testId: string;
  videoUrl: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  duration?: number | null;
  downloadUrl?: string | null;
  downloadName?: string;
}) {
  return (
    <div className="rounded-md border-2 border-slate-300/80 bg-slate-900/40 p-3">
      <div className="mb-2 text-sm font-semibold tracking-wide text-slate-100">
        {label}
      </div>
      <PlayablePreview videoUrl={videoUrl} testId={testId} />
      {videoUrl && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
          {fileName && <span className="truncate text-slate-300">{fileName}</span>}
          {fileSize ? (
            <>
              <span className="text-slate-600">·</span>
              <span>{formatBytes(fileSize)}</span>
            </>
          ) : null}
          {duration !== null && duration !== undefined ? (
            <>
              <span className="text-slate-600">·</span>
              <span>{formatSeconds(duration)}</span>
            </>
          ) : null}
          {downloadUrl && downloadName && (
            <a
              href={downloadUrl}
              download={downloadName}
              className="ml-auto inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          )}
        </div>
      )}
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
