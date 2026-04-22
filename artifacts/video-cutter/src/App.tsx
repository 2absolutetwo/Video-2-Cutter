import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  CheckCircle2,
  Scissors,
  Play,
  Download,
  X,
  ArrowRight,
  Music,
  Film,
  UploadCloud,
  Plus,
  Trash2,
  FolderOpen,
  GripVertical,
  Upload,
  AlertTriangle,
  Crop,
  Activity,
  CheckCheck,
  AlertCircle,
} from "lucide-react";

type PoolItem = {
  id: string;
  file: File;
  kind: "audio" | "video";
  duration: number | null;
};

const PoolContext = createContext<{
  getFile: (id: string) => File | undefined;
}>({ getFile: () => undefined });

const POOL_MIME_ID = "application/x-pool-id";
const POOL_MIME_KIND = "application/x-pool-kind";

const FFMPEG_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
const INITIAL_CARDS = 6;

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

type Stage = "idle" | "reading" | "cutting" | "done" | "error";

type CardState = {
  canCut: boolean;
  isWorking: boolean;
  mode?: "extend" | "trim" | null;
  hasAudio: boolean;
  hasVideo: boolean;
  isDone: boolean;
  mergedUrl?: string | null;
  mergedName?: string;
};

export type CutterCardHandle = {
  runCut: () => Promise<void>;
  loadAudio: (file: File) => void;
  loadVideo: (file: File) => void;
};

function VideoCutterApp() {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(true);
  const [ffmpegError, setFfmpegError] = useState<string>("");

  const progressCbRef = useRef<((p: number) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ffmpeg = new FFmpeg();
        ffmpeg.on("progress", ({ progress }) => {
          const p = Math.min(100, Math.max(0, Math.round(progress * 100)));
          progressCbRef.current?.(p);
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
        setFfmpegError("Failed to load video engine. Please refresh.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setProgressCb = (cb: ((p: number) => void) | null) => {
    progressCbRef.current = cb;
  };

  const [pool, setPool] = useState<PoolItem[]>([]);
  const poolRef = useRef<PoolItem[]>([]);
  poolRef.current = pool;

  const poolCtx = useMemo(
    () => ({
      getFile: (id: string) =>
        poolRef.current.find((p) => p.id === id)?.file,
    }),
    [],
  );

  const addPoolFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const newItems: PoolItem[] = [];
    for (const f of arr) {
      const kind: "audio" | "video" | null = f.type.startsWith("audio/")
        ? "audio"
        : f.type.startsWith("video/")
        ? "video"
        : null;
      if (!kind) continue;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      newItems.push({ id, file: f, kind, duration: null });
    }
    if (newItems.length === 0) return;
    setPool((p) => [...p, ...newItems]);
    for (const item of newItems) {
      try {
        const d = await getMediaDuration(item.file, item.kind);
        setPool((p) =>
          p.map((x) => (x.id === item.id ? { ...x, duration: d } : x)),
        );
      } catch {
        /* ignore */
      }
    }
  };

  const removePoolItem = (id: string) => {
    setPool((p) => p.filter((x) => x.id !== id));
  };

  const clearPool = () => setPool([]);

  const [numCards, setNumCards] = useState(INITIAL_CARDS);
  const cardRefs = useRef<(CutterCardHandle | null)[]>(
    Array(INITIAL_CARDS).fill(null),
  );
  const [cardStates, setCardStates] = useState<CardState[]>(
    Array.from({ length: INITIAL_CARDS }, () => ({
      canCut: false,
      isWorking: false,
      hasAudio: false,
      hasVideo: false,
      isDone: false,
    })),
  );
  const [running, setRunning] = useState(false);
  const [downloadCount, setDownloadCount] = useState(0);
  const incrementDownload = useCallback(() => setDownloadCount((n) => n + 1), []);
  const [zipping, setZipping] = useState(false);

  const handleDownloadZip = async () => {
    const ready = cardStates
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.isDone && c.mergedUrl && c.mergedName);
    if (ready.length === 0) return;
    setZipping(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const used = new Set<string>();
      for (const { c, i } of ready) {
        const res = await fetch(c.mergedUrl!);
        const blob = await res.blob();
        let name = c.mergedName || `merged-${i + 1}.mp4`;
        if (used.has(name)) {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          name = `${base}-${i + 1}${ext}`;
        }
        used.add(name);
        zip.file(name, blob);
      }
      const out = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(out);
      const a = document.createElement("a");
      a.href = url;
      a.download = `video-clips-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setDownloadCount((n) => n + ready.length);
    } catch (e) {
      console.error("zip failed", e);
    } finally {
      setZipping(false);
    }
  };

  const addCard = () => {
    setNumCards((n) => {
      const next = n + 1;
      cardRefs.current.length = next;
      return next;
    });
    setCardStates((prev) => [
      ...prev,
      { canCut: false, isWorking: false, hasAudio: false, hasVideo: false, isDone: false },
    ]);
  };

  const ensureCards = (count: number) => {
    if (count <= numCards) return;
    cardRefs.current.length = count;
    setNumCards(count);
    setCardStates((prev) => {
      if (prev.length >= count) return prev;
      const next = prev.slice();
      while (next.length < count) {
        next.push({ canCut: false, isWorking: false, hasAudio: false, hasVideo: false, isDone: false });
      }
      return next;
    });
  };

  const extractCardNumber = (filename: string): number | null => {
    const m = filename.match(/(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!isFinite(n) || n <= 0) return null;
    return n;
  };

  const pendingLoadRef = useRef<{
    kind: "audio" | "video";
    assignments: { cardIndex: number; file: File }[];
    fallbackFiles: File[];
    requiredCards: number;
  } | null>(null);

  const flushPendingLoad = () => {
    const pending = pendingLoadRef.current;
    if (!pending) return;
    const { kind, assignments, fallbackFiles } = pending;
    const used = new Set<number>();
    let allAssigned = true;

    for (const { cardIndex, file } of assignments) {
      const handle = cardRefs.current[cardIndex];
      if (!handle) {
        allAssigned = false;
        continue;
      }
      if (kind === "audio") handle.loadAudio(file);
      else handle.loadVideo(file);
      used.add(cardIndex);
    }

    let nextSlot = 0;
    for (const file of fallbackFiles) {
      while (used.has(nextSlot)) nextSlot++;
      const handle = cardRefs.current[nextSlot];
      if (!handle) {
        allAssigned = false;
        break;
      }
      if (kind === "audio") handle.loadAudio(file);
      else handle.loadVideo(file);
      used.add(nextSlot);
      nextSlot++;
    }

    if (allAssigned) {
      pendingLoadRef.current = null;
    }
  };

  useEffect(() => {
    if (!pendingLoadRef.current) return;
    if (numCards < pendingLoadRef.current.requiredCards) return;
    const id = requestAnimationFrame(() => flushPendingLoad());
    return () => cancelAnimationFrame(id);
  }, [numCards]);

  const loadPoolToCards = (kind: "audio" | "video") => {
    const items = poolRef.current.filter((p) => p.kind === kind);
    if (items.length === 0) return;

    const assignments: { cardIndex: number; file: File }[] = [];
    const fallbackFiles: File[] = [];
    const claimed = new Set<number>();

    for (const it of items) {
      const num = extractCardNumber(it.file.name);
      if (num !== null && !claimed.has(num - 1)) {
        assignments.push({ cardIndex: num - 1, file: it.file });
        claimed.add(num - 1);
      } else {
        fallbackFiles.push(it.file);
      }
    }

    let maxIndex = -1;
    for (const a of assignments) {
      if (a.cardIndex > maxIndex) maxIndex = a.cardIndex;
    }
    const requiredCards = Math.max(
      maxIndex + 1,
      assignments.length + fallbackFiles.length,
    );

    pendingLoadRef.current = { kind, assignments, fallbackFiles, requiredCards };
    if (requiredCards > numCards) {
      ensureCards(requiredCards);
    } else {
      flushPendingLoad();
    }
  };

  const setCardState = (idx: number) => (s: CardState) => {
    setCardStates((prev) => {
      const cur = prev[idx];
      if (
        cur.canCut === s.canCut &&
        cur.isWorking === s.isWorking &&
        cur.hasAudio === s.hasAudio &&
        cur.hasVideo === s.hasVideo &&
        cur.isDone === s.isDone &&
        cur.mode === s.mode &&
        cur.mergedUrl === s.mergedUrl &&
        cur.mergedName === s.mergedName
      )
        return prev;
      const next = prev.slice();
      next[idx] = s;
      return next;
    });
  };

  const anyWorking =
    running || cardStates.some((c) => c.isWorking);
  const anyCanExtend = cardStates.some(
    (c) => c.canCut && c.mode === "extend",
  );
  const anyCanTrim = cardStates.some(
    (c) => c.canCut && c.mode === "trim",
  );
  const audioPoolCount = pool.filter((p) => p.kind === "audio").length;
  const videoPoolCount = pool.filter((p) => p.kind === "video").length;
  const autoCutCount = cardStates.filter(
    (c) => c.canCut && c.mode === "extend",
  ).length;
  const bothEndsCount = cardStates.filter(
    (c) => c.canCut && c.mode === "trim",
  ).length;
  const activeCount = cardStates.filter(
    (c) => c.hasAudio && c.hasVideo && !c.isDone,
  ).length;
  const completeCount = cardStates.filter((c) => c.isDone).length;
  const errorCount = cardStates.filter(
    (c) => c.hasAudio !== c.hasVideo,
  ).length;
  const canRunAutoCut = ffmpegReady && anyCanExtend && !anyWorking;
  const canRunBothEnds = ffmpegReady && anyCanTrim && !anyWorking;

  const runByMode = async (target: "extend" | "trim") => {
    setRunning(true);
    try {
      for (let i = 0; i < numCards; i++) {
        const cs = cardStates[i];
        if (cs?.canCut && cs.mode === target && cardRefs.current[i]) {
          await cardRefs.current[i]!.runCut();
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const clearAllCards = () => {
    cardRefs.current = [];
    setNumCards(0);
    setCardStates([]);
  };

  const handleAutoCut = () => {
    if (canRunAutoCut) void runByMode("extend");
  };
  const handleBothEnds = () => {
    if (canRunBothEnds) void runByMode("trim");
  };

  return (
   <PoolContext.Provider value={poolCtx}>
    <div className="min-h-screen w-full bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* Header bar */}
        <div className="mb-8 flex items-center justify-between gap-4 rounded-2xl border-2 border-slate-300 bg-white px-6 py-3 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-800">
            Video Clip Cutter
          </h1>
          <div className="flex items-center gap-3">
            {ffmpegLoading && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading engine…
              </span>
            )}
            {!ffmpegLoading && ffmpegReady && (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready
              </span>
            )}
            {ffmpegError && (
              <span className="text-xs text-rose-600">{ffmpegError}</span>
            )}
            {completeCount > 0 && (
              <button
                onClick={handleDownloadZip}
                disabled={zipping}
                data-testid="button-download-zip"
                className="inline-flex min-w-[140px] items-center justify-center rounded-xl border-2 border-indigo-400 bg-white px-5 py-1.5 text-sm font-semibold tracking-wider text-indigo-700 transition hover:border-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {zipping ? (
                  <span className="inline-flex items-center">
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ZIPPING…
                  </span>
                ) : (
                  <span className="inline-flex items-center">
                    <Download className="mr-2 h-3.5 w-3.5" />
                    DOWNLOAD ZIP ({completeCount})
                  </span>
                )}
              </button>
            )}
            <button
              onClick={handleAutoCut}
              disabled={!canRunAutoCut}
              data-testid="button-auto-cut"
              className="inline-flex min-w-[140px] items-center justify-center rounded-xl border-2 border-slate-400 bg-white px-5 py-1.5 text-sm font-semibold tracking-wider text-slate-800 transition hover:border-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {anyWorking ? (
                <span className="inline-flex items-center">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  WORKING…
                </span>
              ) : (
                <span className="inline-flex items-center">
                  <Scissors className="mr-2 h-3.5 w-3.5" />
                  AUTO CUT
                </span>
              )}
            </button>
            <button
              onClick={handleBothEnds}
              disabled={!canRunBothEnds}
              data-testid="button-both-ends"
              className="inline-flex min-w-[140px] items-center justify-center rounded-xl border-2 border-amber-400 bg-white px-5 py-1.5 text-sm font-semibold tracking-wider text-amber-700 transition hover:border-amber-600 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="inline-flex items-center">
                <Crop className="mr-2 h-3.5 w-3.5" />
                BOTH ENDS
              </span>
            </button>
          </div>
        </div>

        {/* Media Pools - separate audio + video */}
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <MediaPool
            kind="audio"
            items={pool.filter((p) => p.kind === "audio")}
            onAdd={addPoolFiles}
            onRemove={removePoolItem}
            onClear={() =>
              setPool((p) => p.filter((x) => x.kind !== "audio"))
            }
            onLoad={() => loadPoolToCards("audio")}
          />
          <MediaPool
            kind="video"
            items={pool.filter((p) => p.kind === "video")}
            onAdd={addPoolFiles}
            onRemove={removePoolItem}
            onClear={() =>
              setPool((p) => p.filter((x) => x.kind !== "video"))
            }
            onLoad={() => loadPoolToCards("video")}
          />
        </div>

        {/* Info card - pool & action summary */}
        <div className="relative mb-6 rounded-2xl border-2 border-slate-200 bg-white px-3 py-2 pr-10 shadow-sm">
          <button
            type="button"
            onClick={clearAllCards}
            disabled={numCards === 0}
            data-testid="button-clear-all-cards"
            title="Remove all cards below"
            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-rose-300 bg-rose-50 text-rose-600 shadow-sm transition hover:border-rose-500 hover:bg-rose-100 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className={`flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 py-1 transition-opacity ${audioPoolCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500 text-white">
                <Music className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                Audio Pool
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-audio-count">
                {audioPoolCount} <span className="text-[10px] font-medium text-slate-500">files</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-pink-200 bg-pink-50/60 px-2.5 py-1 transition-opacity ${videoPoolCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-pink-500 text-white">
                <Film className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-pink-700">
                Video Pool
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-video-count">
                {videoPoolCount} <span className="text-[10px] font-medium text-slate-500">files</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1 transition-opacity ${autoCutCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-700 text-white">
                <Scissors className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-700">
                Auto Cut
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-autocut-count">
                {autoCutCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-2.5 py-1 transition-opacity ${bothEndsCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500 text-white">
                <Crop className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                Both Ends
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-bothends-count">
                {bothEndsCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/60 px-2.5 py-1 transition-opacity ${activeCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500 text-white">
                <Activity className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                Active
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-active-count">
                {activeCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-green-200 bg-green-50/60 px-2.5 py-1 transition-opacity ${completeCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-green-600 text-white">
                <CheckCheck className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-green-700">
                Complete
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-complete-count">
                {completeCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/60 px-2.5 py-1 transition-opacity ${errorCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-500 text-white">
                <AlertCircle className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-700">
                Error
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-error-count">
                {errorCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-1 transition-opacity ${downloadCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500 text-white">
                <Download className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
                Download
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-download-count">
                {downloadCount} <span className="text-[10px] font-medium text-slate-500">files</span>
              </span>
            </div>
          </div>
        </div>

        {/* 2-column grid of cards */}
        <div className="grid gap-5 md:grid-cols-2">
          {Array.from({ length: numCards }, (_, i) => (
            <CutterCard
              key={i}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              index={i + 1}
              ffmpeg={ffmpegRef.current}
              engineReady={ffmpegReady}
              setProgressCb={setProgressCb}
              onStateChange={setCardState(i)}
              onDownload={incrementDownload}
              highlight={cardStates[i]?.isWorking}
            />
          ))}
          <button
            type="button"
            onClick={addCard}
            data-testid="button-add-card"
            className="group flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 p-4 text-slate-500 transition hover:-translate-y-0.5 hover:border-indigo-400 hover:bg-indigo-50/50 hover:text-indigo-600 hover:shadow-md"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-slate-300 transition group-hover:border-indigo-400 group-hover:bg-white">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold tracking-wide">
              Add card
            </span>
            <span className="text-[11px] text-slate-400">
              Create another clip slot
            </span>
          </button>
        </div>

        <div className="mt-10 text-center text-xs text-slate-500">
          Files never leave your device. All processing happens in your browser.
        </div>
      </div>
    </div>
   </PoolContext.Provider>
  );
}

function MediaPool({
  kind,
  items,
  onAdd,
  onRemove,
  onClear,
  onLoad,
}: {
  kind: "audio" | "video";
  items: PoolItem[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onLoad: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const isAudio = kind === "audio";
  const accept = isAudio ? "audio/*" : "video/*";
  const title = isAudio ? "AUDIO POOL" : "VIDEO POOL";
  const headerGradient = isAudio
    ? "from-emerald-500 to-teal-500"
    : "from-rose-500 to-pink-500";
  const Icon = isAudio ? Music : Film;

  const handleAdd = (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) =>
      isAudio ? f.type.startsWith("audio/") : f.type.startsWith("video/"),
    );
    if (arr.length) onAdd(arr);
  };

  return (
    <div className="rounded-2xl border-2 border-slate-300 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${headerGradient} text-white shadow-md`}
          >
            <Icon className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <div>
            <h2 className="text-sm font-bold tracking-wide text-slate-800">
              {title}
            </h2>
            <p className="font-mono text-[11px] text-slate-500">
              {items.length} file{items.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onLoad}
            disabled={items.length === 0}
            data-testid={`button-pool-load-${kind}`}
            aria-label="Load into cards"
            title={`Load ${kind} files into cards by number`}
            className="inline-flex h-8 items-center justify-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-3 text-[11px] font-semibold uppercase tracking-wide text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" />
            Load
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            data-testid="button-pool-add"
            aria-label="Add files"
            title="Add files"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          >
            <Plus className="h-4 w-4" />
          </button>
          {items.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              data-testid="button-pool-clear"
              aria-label="Clear"
              title="Clear"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={accept}
            className="hidden"
            data-testid={`input-pool-${kind}-files`}
            onChange={(e) => {
              if (e.target.files) handleAdd(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) handleAdd(e.dataTransfer.files);
        }}
        className={`max-h-[220px] overflow-y-auto rounded-xl border-2 border-dashed p-3 transition ${
          dragOver
            ? "border-indigo-400 bg-indigo-50/60"
            : "border-slate-200 bg-slate-50/40"
        }`}
        data-testid="dropzone-pool"
      >
        {items.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-slate-400">
            <UploadCloud className="mx-auto mb-1 h-5 w-5" />
            Drop {kind} files here, or click "Add files"
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {items.map((item) => (
              <PoolItemCard
                key={item.id}
                item={item}
                onRemove={() => onRemove(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PoolItemCard({
  item,
  onRemove,
}: {
  item: PoolItem;
  onRemove: () => void;
}) {
  const isAudio = item.kind === "audio";
  const Icon = isAudio ? Music : Film;
  const palette = isAudio
    ? "from-emerald-50 to-teal-50 ring-emerald-200 text-emerald-700"
    : "from-rose-50 to-pink-50 ring-rose-200 text-rose-700";
  const iconBg = isAudio
    ? "bg-gradient-to-br from-emerald-400 to-teal-500"
    : "bg-gradient-to-br from-rose-400 to-pink-500";

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(POOL_MIME_ID, item.id);
        e.dataTransfer.setData(POOL_MIME_KIND, item.kind);
        e.dataTransfer.effectAllowed = "copy";
      }}
      className={`group relative flex cursor-grab items-center gap-2 rounded-lg bg-gradient-to-br ${palette} px-2.5 py-2 ring-1 transition active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-md`}
      data-testid={`pool-item-${item.id}`}
      title={`${item.file.name} · drag onto a card's ${item.kind} slot`}
    >
      <GripVertical className="h-3 w-3 shrink-0 text-slate-400 group-hover:text-slate-600" />
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${iconBg} text-white shadow`}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-slate-700">
          {item.file.name}
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
          <span className="uppercase">{item.kind}</span>
          <span>·</span>
          <span>{formatBytes(item.file.size)}</span>
          {item.duration !== null && (
            <>
              <span>·</span>
              <span>{formatSeconds(item.duration)}</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="opacity-0 transition group-hover:opacity-100"
        data-testid={`button-pool-remove-${item.id}`}
        aria-label="Remove"
      >
        <X className="h-3.5 w-3.5 text-slate-500 hover:text-rose-600" />
      </button>
    </div>
  );
}

type CutterCardProps = {
  index: number;
  ffmpeg: FFmpeg | null;
  engineReady: boolean;
  setProgressCb: (cb: ((p: number) => void) | null) => void;
  onStateChange: (s: CardState) => void;
  onDownload: () => void;
  highlight?: boolean;
};

const CutterCard = forwardRef<CutterCardHandle, CutterCardProps>(
  function CutterCard(
    { index, ffmpeg, engineReady, setProgressCb, onStateChange, onDownload, highlight },
    ref,
  ) {
    const { toast } = useToast();

    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [audioDuration, setAudioDuration] = useState<number | null>(null);
    const [videoDuration, setVideoDuration] = useState<number | null>(null);

    const [stage, setStage] = useState<Stage>("idle");
    const [progress, setProgress] = useState(0);
    const [outputUrl, setOutputUrl] = useState<string | null>(null);
    const [mergedUrl, setMergedUrl] = useState<string | null>(null);
    const [mergedName, setMergedName] = useState<string>("");
    const [mergedSize, setMergedSize] = useState<number>(0);
    const [mergedDuration, setMergedDuration] = useState<number>(0);
    const [errorMsg, setErrorMsg] = useState<string>("");
    const [playing, setPlaying] = useState(false);

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

    const isWorking = stage === "reading" || stage === "cutting";

    const videoTooLong =
      audioDuration !== null &&
      videoDuration !== null &&
      videoDuration > audioDuration;

    const trimAmount =
      videoTooLong && audioDuration !== null && videoDuration !== null
        ? videoDuration - audioDuration
        : 0;
    const trimAllowed =
      videoTooLong &&
      audioDuration !== null &&
      videoDuration !== null &&
      audioDuration > 0 &&
      trimAmount < videoDuration;

    const canCut =
      engineReady &&
      !!ffmpeg &&
      !!audioFile &&
      !!videoFile &&
      videoDuration !== null &&
      audioDuration !== null &&
      !isWorking &&
      ((cutTime !== null && cutTime > 0 && cutTime < videoDuration) ||
        trimAllowed);

    const mode: "extend" | "trim" | null =
      cutTime !== null && cutTime > 0 && videoDuration !== null && cutTime < videoDuration
        ? "extend"
        : trimAllowed
        ? "trim"
        : null;

    const hasAudio = !!audioFile;
    const hasVideo = !!videoFile;
    const isDone = stage === "done";

    useEffect(() => {
      onStateChange({
        canCut,
        isWorking,
        mode,
        hasAudio,
        hasVideo,
        isDone,
        mergedUrl,
        mergedName,
      });
    }, [
      canCut,
      isWorking,
      mode,
      hasAudio,
      hasVideo,
      isDone,
      mergedUrl,
      mergedName,
      onStateChange,
    ]);

    const reset = () => {
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      if (mergedUrl) URL.revokeObjectURL(mergedUrl);
      setOutputUrl(null);
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
      setPlaying(false);
    };

    const runCut = async () => {
      if (!ffmpeg || !audioFile || !videoFile || audioDuration === null || videoDuration === null) return;

      const isExtendCase = cutTime !== null && cutTime > 0 && cutTime < videoDuration;
      const isTrimCase = trimAllowed;
      if (!isExtendCase && !isTrimCase) return;

      setErrorMsg("");
      setProgress(0);
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      if (mergedUrl) URL.revokeObjectURL(mergedUrl);
      setOutputUrl(null);
      setMergedUrl(null);

      const ns = `c${index}_`;
      const ext = (videoFile.name.split(".").pop() || "mp4").toLowerCase();
      const inputName = `${ns}input.${ext}`;
      const outputExt =
        ext === "mov" || ext === "mkv" || ext === "webm" ? ext : "mp4";
      const outName = `Clip 2.${outputExt}`;
      const outFile = `${ns}${outName}`;
      const clip1NoAudio = `${ns}clip1.${outputExt}`;
      const mergedFileName = `Merged ${index}.${outputExt}`;
      const mergedFile = `${ns}${mergedFileName}`;
      const concatFile = `${ns}concat.txt`;

      setProgressCb((p) => setProgress(p));

      try {
        setStage("reading");
        const data = await fetchFile(videoFile);
        await ffmpeg.writeFile(inputName, data);
        const mimeType = outputExt === "webm" ? "video/webm" : "video/mp4";

        if (isTrimCase) {
          // Case 2: Video > Audio — trim equally from both ends so total
          // length equals audio. Stream copy keeps original quality & is fast.
          setStage("cutting");
          const totalCut = videoDuration - audioDuration; // > 0
          const headCut = totalCut / 2;
          await ffmpeg.exec([
            "-ss",
            headCut.toFixed(3),
            "-i",
            inputName,
            "-t",
            audioDuration.toFixed(3),
            "-c",
            "copy",
            "-an",
            "-avoid_negative_ts",
            "make_zero",
            mergedFile,
          ]);

          const mergedData = await ffmpeg.readFile(mergedFile);
          const mergedBuf = mergedData as Uint8Array;
          const mergedBlob = new Blob([mergedBuf.slice().buffer], {
            type: mimeType,
          });
          const mUrl = URL.createObjectURL(mergedBlob);
          setMergedUrl(mUrl);
          setMergedName(mergedFileName);
          setMergedSize(mergedBlob.size);
          setMergedDuration(audioDuration);

          setStage("done");
          setProgress(100);

          try {
            await ffmpeg.deleteFile(inputName);
            await ffmpeg.deleteFile(mergedFile);
          } catch {
            /* ignore */
          }
          return;
        }

        // Case 1: Audio > Video — extend video by repeating last segment
        const startSec = (videoDuration as number) - (cutTime as number);

        setStage("cutting");
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
          outFile,
        ]);

        const out = await ffmpeg.readFile(outFile);
        const outBuf = out as Uint8Array;
        const blob = new Blob([outBuf.slice().buffer], { type: mimeType });
        const url = URL.createObjectURL(blob);
        setOutputUrl(url);

        await ffmpeg.exec([
          "-i",
          inputName,
          "-c",
          "copy",
          "-an",
          clip1NoAudio,
        ]);

        const concatList = `file '${clip1NoAudio}'\nfile '${outFile}'\n`;
        await ffmpeg.writeFile(
          concatFile,
          new TextEncoder().encode(concatList),
        );

        await ffmpeg.exec([
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatFile,
          "-c",
          "copy",
          mergedFile,
        ]);

        const mergedData = await ffmpeg.readFile(mergedFile);
        const mergedBuf = mergedData as Uint8Array;
        const mergedBlob = new Blob([mergedBuf.slice().buffer], {
          type: mimeType,
        });
        const mUrl = URL.createObjectURL(mergedBlob);
        setMergedUrl(mUrl);
        setMergedName(mergedFileName);
        setMergedSize(mergedBlob.size);
        setMergedDuration((videoDuration as number) + (cutTime as number));

        setStage("done");
        setProgress(100);

        try {
          await ffmpeg.deleteFile(inputName);
          await ffmpeg.deleteFile(outFile);
          await ffmpeg.deleteFile(clip1NoAudio);
          await ffmpeg.deleteFile(mergedFile);
          await ffmpeg.deleteFile(concatFile);
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
      } finally {
        setProgressCb(null);
      }
    };

    useImperativeHandle(ref, () => ({
      runCut,
      loadAudio: (file: File) => {
        void handleAudio(file);
      },
      loadVideo: (file: File) => {
        void handleVideo(file);
      },
    }));

    const videoSwapRef = useRef<HTMLInputElement | null>(null);

    return (
      <div
        className={`rounded-2xl border-2 bg-white p-4 shadow-sm transition-colors ${
          videoTooLong && trimAllowed
            ? "border-amber-400 shadow-md shadow-amber-200/50 bg-amber-50/40"
            : videoTooLong
            ? "border-rose-500 shadow-md shadow-rose-200/50 bg-rose-50/40"
            : (!!audioFile !== !!videoFile)
            ? "border-rose-500 shadow-md shadow-rose-200/50 bg-rose-50/40"
            : highlight
            ? "border-cyan-500 shadow-md"
            : "border-slate-300"
        }`}
      >
        <input
          ref={videoSwapRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (f) {
              void handleVideo(f);
            }
            if (e.target) e.target.value = "";
          }}
          data-testid={`input-video-swap-${index}`}
        />
        <div className="flex items-stretch gap-3">
          {/* Number circle */}
          <div className="flex shrink-0 items-center justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-slate-400 font-mono text-sm font-bold text-slate-700">
              {String(index).padStart(3, "0")}
            </div>
          </div>

          {/* Stacked uploads */}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
            <UploadBox
              kind="audio"
              file={audioFile}
              duration={audioDuration}
              onChange={handleAudio}
              disabled={isWorking}
              testIdSuffix={`-${index}`}
            />
            <UploadBox
              kind="video"
              file={videoFile}
              duration={videoDuration}
              onChange={handleVideo}
              disabled={isWorking}
              testIdSuffix={`-${index}`}
            />
          </div>

          {/* Arrow */}
          <div className="flex shrink-0 items-center justify-center">
            <ArrowRight className="h-5 w-5 text-slate-500" />
          </div>

          {/* Preview + action buttons stacked vertically */}
          <div className="flex shrink-0 flex-col items-center gap-2">
            <PlayablePreview
              videoUrl={mergedUrl}
              playing={playing}
              setPlaying={setPlaying}
              testId={`video-merged-${index}`}
            />
            <div className="flex w-full items-center justify-center gap-1.5">
              <ActionButton
                onClick={reset}
                disabled={
                  !audioFile && !videoFile && !mergedUrl && !errorMsg
                }
                icon={<X className="h-3 w-3" />}
                label="cancel"
                testId={`button-cancel-${index}`}
                variant="cancel"
              />
              <ActionButton
                onClick={() => mergedUrl && setPlaying(true)}
                disabled={!mergedUrl}
                icon={<Play className="h-3 w-3" />}
                label="play"
                testId={`button-play-${index}`}
                variant="play"
              />
              <ActionButton
                as="a"
                href={mergedUrl ?? undefined}
                download={mergedName || undefined}
                disabled={!mergedUrl}
                onClick={onDownload}
                icon={<Download className="h-3 w-3" />}
                label="download"
                testId={`button-download-${index}`}
                variant="download"
              />
            </div>
          </div>
        </div>

        {/* Status row */}
        {(isWorking || errorMsg || videoTooLong || (cutTime !== null && cutTime > 0) || mergedUrl) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            {videoTooLong && !mergedUrl && trimAllowed && (
              <span className="inline-flex items-center gap-1.5 rounded border border-amber-400 bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                <AlertTriangle className="h-3 w-3" />
                trim ±{formatSeconds(trimAmount / 2)} both ends
              </span>
            )}
            {videoTooLong && !mergedUrl && !trimAllowed && (
              <span className="inline-flex items-center gap-1.5 rounded border border-rose-400 bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">
                <AlertTriangle className="h-3 w-3" />
                Video longer than audio (+{formatSeconds(Math.abs(cutTime ?? 0))})
              </span>
            )}
            {cutTime !== null && cutTime > 0 && !mergedUrl && (
              <span className="rounded border border-cyan-300 bg-cyan-50 px-2 py-0.5 font-mono text-cyan-700">
                trim −{formatSeconds(cutTime)}
              </span>
            )}
            {isWorking && (
              <span className="flex flex-1 items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <span
                    className="block h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </span>
                <span className="font-mono">
                  {progress}% · {stage}
                </span>
              </span>
            )}
            {mergedUrl && !isWorking && (
              <>
                <span className="truncate text-slate-700">{mergedName}</span>
                <span>·</span>
                <span>{formatBytes(mergedSize)}</span>
                <span>·</span>
                <span>{formatSeconds(mergedDuration)}</span>
              </>
            )}
            {errorMsg && (
              <span className="text-rose-600">{errorMsg}</span>
            )}
          </div>
        )}
      </div>
    );
  },
);

function ActionButton({
  onClick,
  disabled,
  icon,
  label,
  testId,
  as,
  href,
  download,
  variant = "cancel",
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  testId: string;
  as?: "a";
  href?: string;
  download?: string;
  variant?: "cancel" | "play" | "download";
}) {
  const variantCls =
    variant === "play"
      ? "border-emerald-300 bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-700 hover:from-emerald-100 hover:to-emerald-200 hover:border-emerald-500"
      : variant === "download"
      ? "border-indigo-300 bg-gradient-to-b from-indigo-50 to-indigo-100 text-indigo-700 hover:from-indigo-100 hover:to-indigo-200 hover:border-indigo-500"
      : "border-rose-300 bg-gradient-to-b from-rose-50 to-rose-100 text-rose-700 hover:from-rose-100 hover:to-rose-200 hover:border-rose-500";

  const cls = `inline-flex flex-1 items-center justify-center gap-1 rounded-full border px-3 py-1.5 text-[11px] font-semibold tracking-wide shadow-sm transition active:scale-95 ${variantCls} ${
    disabled ? "pointer-events-none opacity-40" : ""
  }`;

  if (as === "a") {
    return (
      <a
        href={disabled ? undefined : href}
        download={download}
        onClick={disabled ? undefined : onClick}
        className={cls}
        data-testid={testId}
        aria-disabled={disabled}
      >
        {icon}
        {label}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cls}
      data-testid={testId}
    >
      {icon}
      {label}
    </button>
  );
}

function UploadBox({
  kind,
  file,
  duration,
  onChange,
  disabled,
  testIdSuffix = "",
}: {
  kind: "audio" | "video";
  file: File | null;
  duration: number | null;
  onChange: (f: File | null) => void;
  disabled?: boolean;
  testIdSuffix?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isAudio = kind === "audio";
  const hasFile = !!file;
  const poolCtx = useContext(PoolContext);
  const [dropActive, setDropActive] = useState(false);
  const [dropReject, setDropReject] = useState(false);

  const palette = isAudio
    ? {
        gradient:
          "from-emerald-50 via-white to-teal-50/60 hover:from-emerald-100/80 hover:via-white hover:to-teal-100/60",
        ring: "ring-emerald-200/70 hover:ring-emerald-300",
        ringActive: "ring-emerald-400 shadow-emerald-200/50",
        iconBg: "bg-gradient-to-br from-emerald-400 to-teal-500",
        iconShadow: "shadow-emerald-300/40",
        accentText: "text-emerald-700",
        chipBg: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20",
        dot: "bg-emerald-500",
      }
    : {
        gradient:
          "from-rose-50 via-white to-pink-50/60 hover:from-rose-100/80 hover:via-white hover:to-pink-100/60",
        ring: "ring-rose-200/70 hover:ring-rose-300",
        ringActive: "ring-rose-400 shadow-rose-200/50",
        iconBg: "bg-gradient-to-br from-rose-400 to-pink-500",
        iconShadow: "shadow-rose-300/40",
        accentText: "text-rose-700",
        chipBg: "bg-rose-500/10 text-rose-700 ring-rose-500/20",
        dot: "bg-rose-500",
      };

  const Icon = isAudio ? Music : Film;
  const label = isAudio ? "Audio" : "Video";
  const accept = isAudio ? "audio/*" : "video/*";

  return (
    <div
      className={`group relative cursor-pointer overflow-hidden rounded-xl bg-gradient-to-br ${palette.gradient} px-3 py-2.5 ring-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${
        dropReject
          ? "ring-2 ring-rose-500 shadow-rose-200/60"
          : dropActive
          ? "ring-2 ring-indigo-500 shadow-indigo-200/60 scale-[1.02]"
          : hasFile
          ? `${palette.ringActive} shadow-md`
          : palette.ring
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        const types = Array.from(e.dataTransfer.types || []);
        if (types.includes(POOL_MIME_KIND)) {
          const k = e.dataTransfer.getData(POOL_MIME_KIND);
          if (k && k !== kind) {
            setDropReject(true);
            setDropActive(false);
            e.dataTransfer.dropEffect = "none";
            return;
          }
        }
        setDropActive(true);
        setDropReject(false);
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        setDropActive(false);
        setDropReject(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        setDropReject(false);
        const poolId = e.dataTransfer.getData(POOL_MIME_ID);
        const poolKind = e.dataTransfer.getData(POOL_MIME_KIND);
        if (poolId) {
          if (poolKind && poolKind !== kind) return;
          const f = poolCtx.getFile(poolId);
          if (f) onChange(f);
          return;
        }
        const f = e.dataTransfer.files?.[0];
        if (f) onChange(f);
      }}
      data-testid={`upload-${kind}${testIdSuffix}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        data-testid={`input-${kind}${testIdSuffix}`}
      />
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-md transition-all duration-200 ${
            hasFile
              ? `${palette.iconBg} text-white ${palette.iconShadow}`
              : `bg-white text-white ring-1 ${isAudio ? "ring-emerald-200" : "ring-rose-200"}`
          }`}
        >
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[11px] font-semibold tracking-wide ${palette.accentText}`}>
              {label}
            </span>
            {duration !== null ? (
              <span
                className={`rounded-full px-1.5 py-px font-mono text-[10px] ring-1 ${palette.chipBg}`}
              >
                {formatSeconds(duration)}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-medium text-slate-400">
                <UploadCloud className="h-3 w-3" />
                upload
              </span>
            )}
          </div>
          {hasFile ? (
            <div
              className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-slate-600"
              data-testid={`text-${kind}-name${testIdSuffix}`}
              title={file.name}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${palette.dot}`} />
              <span className="truncate">
                {file.name} · {formatBytes(file.size)}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 truncate text-[10px] text-slate-400">
              Drop or click to add {isAudio ? "an audio" : "a video"} file
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayablePreview({
  videoUrl,
  playing,
  setPlaying,
  testId,
}: {
  videoUrl: string | null;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  testId: string;
}) {
  if (!videoUrl) {
    return (
      <div
        className="flex h-[96px] w-[150px] items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 text-[10px] text-slate-400"
        data-testid={`${testId}-empty`}
      >
        preview
      </div>
    );
  }

  if (playing) {
    return (
      <video
        src={videoUrl}
        controls
        autoPlay
        className="h-[96px] w-[150px] rounded-lg border-2 border-slate-700 bg-black shadow-md"
        data-testid={testId}
        onEnded={() => setPlaying(false)}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      className="group relative flex h-[96px] w-[150px] items-center justify-center rounded-lg border-2 border-slate-700 bg-black shadow-md transition hover:border-slate-900"
      data-testid={`${testId}-play`}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 backdrop-blur transition group-hover:scale-110 group-hover:bg-white/30">
        <Play className="h-3.5 w-3.5 text-white" />
      </span>
    </button>
  );
}

function App() {
  return (
    <TooltipProvider>
      <VideoCutterApp />
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
