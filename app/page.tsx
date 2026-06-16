"use client";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import Image from "next/image";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  FileAudio2,
  FolderOpen,
  History,
  Library,
  Loader2,
  Music2,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strings } from "./strings";

type Mode = "files" | "folder";
type ConversionStatus = "waiting" | "converting" | "done" | "failed";
type SectionId = "convert" | "queue" | "history" | "settings";

type ProgressInfo = { processed: number; total: number };

type ConversionRecord = {
  source: string;
  output: string | null;
  status: ConversionStatus;
  message: string;
  /** Live byte progress, present only while `status === "converting"`. */
  progress: ProgressInfo | null;
};

type ConversionResult = {
  source: string;
  output: string | null;
  success: boolean;
  message: string;
};

type AppSettings = {
  outputDir: string | null;
  recursive: boolean;
  removeOriginal: boolean;
  jobs: number;
  autoScanDefault: boolean;
};

type HistoryRecord = {
  source: string;
  output: string | null;
  success: boolean;
  message: string;
  convertedAt: number;
};

type DefaultCacheScan = {
  path: string | null;
  files: string[];
};

type AppData = {
  settings: AppSettings;
  history: HistoryRecord[];
  defaultCache: DefaultCacheScan;
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const RECENT_QUEUE_LIMIT = 5;
const RECENT_HISTORY_LIMIT = 8;
const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "label",
  "textarea",
  "select",
  "a",
  "[role='button']",
  "[role='switch']",
  "[role='tab']",
].join(",");

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatHistoryTime(seconds: number): string {
  if (!seconds) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

// `useEffect` captures the version of a callback that was current at the
// time the effect ran. For keyboard shortcuts we want the latest closure on
// every keystroke, so we mirror each function into a ref and read through
// that ref inside the keydown handler.
function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("files");
  const [activeSection, setActiveSection] = useState<SectionId>("convert");
  const [records, setRecords] = useState<ConversionRecord[]>([]);
  const [folder, setFolder] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [removeOriginal, setRemoveOriginal] = useState(false);
  const [jobs, setJobs] = useState(2);
  const [autoScanDefault, setAutoScanDefault] = useState(true);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [defaultCache, setDefaultCache] = useState<DefaultCacheScan | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{
    tone: "error" | "info";
    text: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const selectedCount = useMemo(
    () => records.filter((r) => r.status !== "done" && r.status !== "failed").length,
    [records],
  );

  const summary = useMemo(() => {
    let ok = 0,
      failed = 0;
    for (const r of records) {
      if (r.status === "done") ok++;
      else if (r.status === "failed") failed++;
    }
    return { ok, failed };
  }, [records]);

  const canConvert = selectedCount > 0 && !busy;

  const showToast = useCallback(
    (tone: "error" | "info", text: string, action?: { label: string; onClick: () => void }) => {
      setToast({ tone, text, actionLabel: action?.label, onAction: action?.onClick });
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    void invoke<AppData>("load_app_data")
      .then((data) => {
        if (cancelled) return;
        setOutputDir(data.settings.outputDir ?? "");
        setRecursive(data.settings.recursive);
        setRemoveOriginal(data.settings.removeOriginal);
        setJobs(Math.min(8, Math.max(1, data.settings.jobs || 2)));
        setAutoScanDefault(data.settings.autoScanDefault);
        setHistory(data.history);
        setDefaultCache(data.defaultCache);
      })
      .catch((err) => {
        if (!cancelled) {
          showToast("error", err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setSettingsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!settingsReady) return;
    const id = window.setTimeout(() => {
      void invoke("save_settings", {
        settings: {
          outputDir: outputDir || null,
          recursive,
          removeOriginal,
          jobs,
          autoScanDefault,
        },
      }).catch((err) => showToast("error", err instanceof Error ? err.message : String(err)));
    }, 350);

    return () => window.clearTimeout(id);
  }, [autoScanDefault, jobs, outputDir, recursive, removeOriginal, settingsReady, showToast]);

  const mergeScannedFiles = useCallback((nextSources: string[]) => {
    setRecords((previous) => {
      const seen = new Map(previous.map((r) => [r.source, r]));
      const merged: ConversionRecord[] = [];
      for (const source of nextSources) {
        const existing = seen.get(source);
        if (existing) {
          merged.push(existing);
        } else {
          merged.push({
            source,
            output: null,
            status: "waiting",
            message: "",
            progress: null,
          });
        }
      }
      return merged;
    });
  }, []);

  const scanPaths = useCallback(
    async (paths: string[], merge = false) => {
      if (paths.length === 0) return;
      try {
        const scanned = await invoke<string[]>("scan_ncm_paths", { paths, recursive });
        if (scanned.length === 0) {
          showToast("error", strings.toast.noNcm);
          return;
        }
        if (merge) {
          setRecords((previous) => {
            const known = new Set(previous.map((r) => r.source));
            const additions = scanned
              .filter((s) => !known.has(s))
              .map((source) => ({
                source,
                output: null,
                status: "waiting" as ConversionStatus,
                message: "",
                progress: null,
              }));
            return [...previous, ...additions];
          });
        } else {
          mergeScannedFiles(scanned);
        }
        showToast("info", strings.toast.addedToQueue(scanned.length));
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : String(err));
      }
    },
    [mergeScannedFiles, recursive, showToast],
  );

  useEffect(() => {
    const unlistens: Array<() => void> = [];

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragActive((prev) => (prev ? prev : true));
          return;
        }
        if (event.payload.type === "leave") {
          setDragActive(false);
          return;
        }
        if (event.payload.type === "drop") {
          setDragActive(false);
          void scanPaths(event.payload.paths, true);
        }
      })
      .then((unlisten) => unlistens.push(unlisten));

    void getCurrentWebview()
      .listen<{
        source: string;
        output: string | null;
        status: ConversionStatus;
        message: string;
        processed: number;
        total: number;
      }>("conversion-progress", (event) => {
        const p = event.payload;
        setRecords((previous) =>
          previous.map((r) => {
            if (r.source !== p.source) return r;
            // Progress events arrive at ~20 Hz; the row component derives
            // its bar width from `progress` when status is "converting".
            if (p.status === "converting" && p.total > 0) {
              return {
                source: r.source,
                output: p.output,
                status: p.status,
                message: p.message,
                progress: { processed: p.processed, total: p.total },
              };
            }
            // Done / failed: drop the progress info.
            return {
              source: r.source,
              output: p.output,
              status: p.status,
              message: p.message,
              progress: null,
            };
          }),
        );
      })
      .then((unlisten) => unlistens.push(unlisten));

    return () => {
      for (const u of unlistens) u();
    };
  }, [scanPaths]);

  // Smoothly scroll to a section card. The main scroll container is the
  // <section> on the right, but if everything fits the viewport we can fall
  // back to the page itself.
  const scrollToSection = useCallback((id: SectionId) => {
    setActiveSection(id);
    const target = document.getElementById(`section-${id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Refs that the global keydown handler reads through so it always sees
  // the latest closures (which close over the latest `records` / `busy`).
  const chooseFilesRef = useLatestRef(chooseFiles);
  const chooseFolderRef = useLatestRef(chooseFolder);
  const convertRef = useLatestRef(convert);
  const cancelRef = useLatestRef(cancel);
  const clearAllRef = useLatestRef(clearAll);
  const canConvertRef = useLatestRef(canConvert);
  const busyRef = useLatestRef(busy);

  // Application-level keyboard shortcuts. Active whenever the window has
  // focus *and* the active element is not a text input. macOS uses ⌘
  // (metaKey), every other platform uses Ctrl.
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const handler = (event: KeyboardEvent) => {
      if (event.altKey) return;
      if (isMac ? !event.metaKey : !event.ctrlKey) return;
      if (isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      const mod = event.shiftKey;

      if (key === "o" && !mod) {
        event.preventDefault();
        void chooseFilesRef.current();
        return;
      }
      if (key === "o" && mod) {
        event.preventDefault();
        void chooseFolderRef.current();
        return;
      }
      if (key === "enter" || (key === "r" && !mod)) {
        event.preventDefault();
        if (canConvertRef.current) {
          void convertRef.current();
        }
        return;
      }
      if (key === ".") {
        event.preventDefault();
        if (busyRef.current) {
          void cancelRef.current();
        }
        return;
      }
      if (key === "l" && !mod) {
        event.preventDefault();
        clearAllRef.current();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busyRef, canConvertRef, cancelRef, chooseFilesRef, chooseFolderRef, clearAllRef, convertRef]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .listen<string>("tray-action", (event) => {
        if (event.payload === "pick-files") {
          void chooseFilesRef.current();
          return;
        }
        if (event.payload === "pick-folder") {
          void chooseFolderRef.current();
          return;
        }
        if (event.payload === "convert" && canConvertRef.current) {
          void convertRef.current();
        }
      })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      });

    return () => {
      unlisten?.();
    };
  }, [canConvertRef, chooseFilesRef, chooseFolderRef, convertRef]);

  async function chooseFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "NCM 音乐缓存", extensions: ["ncm"] }],
    });
    if (Array.isArray(selected)) {
      setMode("files");
      await scanPaths(selected);
    } else if (typeof selected === "string") {
      setMode("files");
      await scanPaths([selected]);
    }
  }

  async function chooseFolder() {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      setFolder(selected);
      setMode("folder");
      await scanPaths([selected]);
    }
  }

  async function chooseOutput() {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      setOutputDir(selected);
    }
  }

  function addDefaultCacheToQueue() {
    if (!defaultCache?.files.length) return;
    setMode("files");
    mergeScannedFiles(defaultCache.files);
    showToast("info", strings.toast.defaultCacheAdded(defaultCache.files.length));
  }

  async function revealPath(path: string | null) {
    if (!path) return;
    try {
      await invoke("reveal_in_finder", { path });
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function clearHistoryList() {
    try {
      const next = await invoke<HistoryRecord[]>("clear_history");
      setHistory(next);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : String(err));
    }
  }

  async function convert() {
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setRecords((previous) =>
        previous.map((r) => ({ ...r, output: null, status: "waiting", message: "", progress: null })),
      );
      const results = await invoke<ConversionResult[]>("convert_ncm", {
        request: {
          mode: "files",
          files: records.map((r) => r.source),
          folder,
          outputDir: outputDir || null,
          recursive,
          removeOriginal,
          jobs,
        },
      });
      const convertedAt = Math.floor(Date.now() / 1000);
      setHistory((previous) => [
        ...results.map((result) => ({
          source: result.source,
          output: result.output,
          success: result.success,
          message: result.message,
          convertedAt,
        })),
        ...previous,
      ].slice(0, 100));
      const ok = results.filter((result) => result.success).length;
      const failed = results.length - ok;
      const revealTarget = results.find((result) => result.success && result.output)?.output ?? null;
      showToast("info", strings.toast.convertDone(ok, failed), revealTarget
        ? { label: strings.buttons.reveal, onClick: () => void revealPath(revealTarget) }
        : undefined);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function cancel() {
    try {
      await invoke("cancel_ncm");
      showToast("info", strings.toast.cancelled);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : String(err));
    }
  }

  function clearAll() {
    setRecords([]);
    setFolder("");
    setOutputDir("");
    setToast(null);
  }

  const visibleQueue = records.slice(0, RECENT_QUEUE_LIMIT);
  const overflow = records.length - visibleQueue.length;

  function startWindowDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    void getCurrentWindow().startDragging();
  }

  return (
    // Drag region is set on the outermost <main> only. Every button / label /
    // input inside carries `-webkit-app-region: no-drag` (see globals.css),
    // so the whole empty area drags the window while controls stay clickable.
    //
    // Padding carve-out: the overlay titlebar's traffic-light buttons live
    // at roughly (8..36, 13..27). `pl-12` (48 px) and `pt-10` (40 px) push
    // the sidebar logo well clear of them so the round buttons don't sit on
    // top of the red gradient badge.
    <main
      className="app-shell relative flex h-screen flex-col gap-2.5 p-2 pl-5 pt-8 text-primary"
      data-tauri-drag-region
      onPointerDown={startWindowDrag}
    >
      <div
        aria-hidden="true"
        className="window-drag-strip fixed left-[148px] right-0 top-0 z-40 h-10"
        data-tauri-drag-region
        onPointerDown={startWindowDrag}
      />

      {dragActive ? (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-[18px] border-2 border-dashed border-accent/70 bg-accent/5">
          <div className="flex items-center gap-3 rounded-2xl bg-inverse/80 px-5 py-3 text-sm font-semibold text-on-accent shadow-2xl backdrop-blur-xl">
            <Sparkles size={18} className="text-accent" aria-hidden="true" />
            {strings.drop.hover}
          </div>
        </div>
      ) : null}

      <div
        className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 md:grid-cols-[220px_1fr]"
        data-tauri-drag-region
      >
        {/* Sidebar */}
        <aside
          className="glass-frame flex flex-col gap-3.5 rounded-[16px] surface-deep p-3.5 glass-highlight"
          data-tauri-drag-region
        >
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl shadow-[0_8px_24px_rgb(var(--accent-glow)/0.32)]">
              <Image
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                height={40}
                priority
                src="/app-icon.png"
                width={40}
              />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold leading-tight tracking-tight text-primary">
                {strings.app.title}
              </div>
              <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                {strings.app.subtitle}
              </div>
            </div>
          </div>

          <nav className="flex flex-col gap-1">
            <SidebarItem
              active={activeSection === "convert"}
              icon={<Download size={16} />}
              label={strings.nav.convert}
              onClick={() => scrollToSection("convert")}
            />
            <SidebarItem
              active={activeSection === "queue"}
              badge={selectedCount > 0 ? String(selectedCount) : undefined}
              icon={<Library size={16} />}
              label={strings.nav.queue}
              onClick={() => scrollToSection("queue")}
            />
            <SidebarItem
              active={activeSection === "history"}
              badge={history.length > 0 ? String(history.length) : undefined}
              icon={<History size={16} />}
              label={strings.nav.history}
              onClick={() => scrollToSection("history")}
            />
            <SidebarItem
              active={activeSection === "settings"}
              icon={<Settings2 size={16} />}
              label={strings.nav.settings}
              onClick={() => scrollToSection("settings")}
            />
          </nav>

          <div className="mt-2 rounded-2xl bg-well/25 p-3 soft-ring">
            <SidebarStat label={strings.stats.ncmFiles} value={mode === "files" ? records.length : 0} />
            <SidebarStat label={strings.stats.folderMode} value={folder ? 1 : 0} />
            <SidebarStat label={strings.stats.history} value={history.length} />
          </div>

          <div className="mt-auto rounded-2xl bg-card/18 p-4 soft-ring">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {strings.stats.sources}
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-3xl font-black tabular-nums leading-none tracking-tight text-primary">
                {selectedCount}
              </span>
              <span className="text-xs font-semibold text-muted">/ {records.length}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <MiniStat label={strings.stats.done} value={summary.ok} tone="good" />
              <MiniStat
                label={strings.stats.failed}
                value={summary.failed}
                tone={summary.failed > 0 ? "bad" : "muted"}
              />
            </div>
          </div>
        </aside>

        {/* Main column. The right column is the scroll container; we give it
            an explicit overflow so smooth scroll-to-section behaves inside
            the Tauri webview. */}
        <section
          className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1"
          data-tauri-drag-region
        >
          <Header
            busy={busy}
            canConvert={canConvert}
            onClear={clearAll}
            onConvert={convert}
            onCancel={cancel}
          />

          <Card id="section-convert">
            <SectionHeader title={strings.sections.sourceTitle} subtitle={strings.sections.sourceDesc}>
              <div className="grid grid-cols-2 rounded-lg bg-well/35 p-0.5 soft-ring">
                <ModeButton active={mode === "files"} label="文件" onClick={() => setMode("files")} />
                <ModeButton active={mode === "folder"} label="文件夹" onClick={() => setMode("folder")} />
              </div>
            </SectionHeader>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <SourceButton
                active={mode === "files" && records.length > 0}
                description={strings.buttons.pickFilesDesc}
                icon={<FileAudio2 size={20} />}
                onClick={chooseFiles}
                step="01"
                title={strings.buttons.pickFiles}
              />
              <SourceButton
                active={mode === "folder" && Boolean(folder)}
                description={strings.buttons.pickFolderDesc}
                icon={<FolderOpen size={20} />}
                onClick={chooseFolder}
                step="02"
                title={strings.buttons.pickFolder}
              />
            </div>

            {autoScanDefault && defaultCache?.files.length ? (
              <button
                className="accent-frame mt-3 flex w-full items-center justify-between gap-3 rounded-xl bg-card/12 px-3.5 py-3 text-left soft-ring transition hover:bg-card/18"
                onClick={addDefaultCacheToQueue}
                type="button"
              >
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold text-primary">
                    {strings.defaultCache.found(defaultCache.files.length)}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {defaultCache.path}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-card/60 px-2.5 py-1.5 text-xs font-bold text-accent soft-ring">
                  {strings.defaultCache.add}
                  <ArrowRight size={12} aria-hidden="true" />
                </span>
              </button>
            ) : null}
          </Card>

          <Card id="section-settings">
            <SectionHeader title={strings.sections.outputTitle} subtitle={strings.sections.outputDesc} />

            <button
              className="accent-frame output-focus priority-action group mt-3 flex min-h-[76px] w-full items-center justify-between gap-3 rounded-xl px-4 text-left transition"
              onClick={chooseOutput}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-card/35 text-accent soft-ring transition group-hover:bg-card/48">
                  <FolderOpen size={18} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="step-badge">03</span>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                      {strings.output.label}
                    </span>
                  </span>
                  <span className="mt-1.5 block truncate text-[15px] font-black text-primary">
                    {outputDir || strings.output.placeholder}
                  </span>
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-card/55 px-3 py-2 text-xs font-bold text-primary soft-ring transition group-hover:bg-card/75">
                {strings.buttons.pickOutput}
              </span>
            </button>

            <div className="mt-3">
              <JobsControl value={jobs} onChange={setJobs} />
            </div>

            <button
              aria-expanded={advancedOpen}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-well/25 px-3 text-[11px] font-bold text-muted soft-ring transition hover:bg-card/45 hover:text-primary"
              onClick={() => setAdvancedOpen((open) => !open)}
              type="button"
            >
              {strings.buttons.advanced}
              <ChevronDown
                className={clsx("transition-transform", advancedOpen && "rotate-180")}
                size={13}
                aria-hidden="true"
              />
            </button>

            {advancedOpen ? (
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <ToggleCard
                  checked={recursive}
                  description={strings.buttons.recursiveDesc}
                  label={strings.buttons.recursive}
                  onChange={setRecursive}
                />
                <ToggleCard
                  checked={removeOriginal}
                  description={strings.buttons.removeOriginalDesc}
                  label={strings.buttons.removeOriginal}
                  onChange={setRemoveOriginal}
                />
                <ToggleCard
                  checked={autoScanDefault}
                  description={strings.buttons.autoScanDefaultDesc}
                  label={strings.buttons.autoScanDefault}
                  onChange={setAutoScanDefault}
                />
              </div>
            ) : null}
          </Card>

          <Card id="section-queue">
            <SectionHeader
              title={strings.sections.queueTitle}
              subtitle={selectedCount > 0 ? strings.sections.queueReady : strings.sections.queueEmpty}
            >
              {removeOriginal ? (
                <div className="inline-flex items-center gap-1.5 rounded-full bg-bad/12 px-2.5 py-1 text-[11px] font-semibold text-bad ring-1 ring-bad/25">
                  <Trash2 size={12} aria-hidden="true" />
                  {strings.badges.removeOn}
                </div>
              ) : null}
            </SectionHeader>

            <div className="mt-4 space-y-1.5">
              {visibleQueue.map((item) => (
                <PathRow item={item} key={item.source} onReveal={revealPath} />
              ))}
              {overflow > 0 ? (
                <div className="px-3 py-1.5 text-xs font-medium text-faint">
                  {strings.badges.moreFiles(overflow)}
                </div>
              ) : null}
              {records.length === 0 ? (
                <div className="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-xl bg-well/25 text-center text-xs text-faint soft-ring">
                  <Search size={16} aria-hidden="true" />
                  {strings.drop.empty}
                </div>
              ) : null}
            </div>

            <MobileActions busy={busy} canConvert={canConvert} onConvert={convert} onClear={clearAll} />
          </Card>

          <Card id="section-history">
            <SectionHeader
              title={strings.sections.historyTitle}
              subtitle={
                history.length > 0
                  ? strings.sections.historyReady(history.length)
                  : strings.sections.historyEmpty
              }
            >
              {history.length > 0 ? (
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-well/30 px-3 text-[11px] font-semibold text-muted soft-ring transition hover:bg-card/50 hover:text-primary"
                  onClick={clearHistoryList}
                  type="button"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  {strings.buttons.clearHistory}
                </button>
              ) : null}
            </SectionHeader>

            <div className="mt-4 space-y-1.5">
              {history.slice(0, RECENT_HISTORY_LIMIT).map((item) => (
                <HistoryRow item={item} key={`${item.convertedAt}-${item.source}`} onReveal={revealPath} />
              ))}
              {history.length > RECENT_HISTORY_LIMIT ? (
                <div className="px-3 py-1.5 text-xs font-medium text-faint">
                  {strings.badges.moreHistory(history.length - RECENT_HISTORY_LIMIT)}
                </div>
              ) : null}
              {history.length === 0 ? (
                <div className="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-xl bg-well/25 text-center text-xs text-faint soft-ring">
                  <History size={16} aria-hidden="true" />
                  {strings.history.empty}
                </div>
              ) : null}
            </div>
          </Card>

          {toast ? (
            <div
              className={clsx(
                "fixed bottom-5 right-5 z-50 flex max-w-[340px] items-center gap-3 rounded-2xl border p-3 text-[12px] font-semibold leading-relaxed shadow-2xl backdrop-blur-xl transition",
                toast.tone === "error"
                  ? "border-bad/25 bg-bad/10 text-bad"
                  : "border-subtle bg-card/72 text-primary",
              )}
              role="status"
            >
              <span className="min-w-0 flex-1">{toast.text}</span>
              {toast.actionLabel && toast.onAction ? (
                <button
                  className="shrink-0 rounded-lg bg-well/50 px-2.5 py-1.5 text-[11px] font-bold text-primary soft-ring transition hover:bg-card/70"
                  onClick={toast.onAction}
                  type="button"
                >
                  {toast.actionLabel}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function Header({
  busy,
  canConvert,
  onClear,
  onConvert,
  onCancel,
}: {
  busy: boolean;
  canConvert: boolean;
  onClear: () => void;
  onConvert: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-end justify-between gap-3 px-1 pb-0.5">
      <div>
        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-accent">
          {strings.header.kicker}
        </div>
        <h1 className="mt-1 text-[24px] font-black leading-none tracking-tight text-primary">
          {strings.header.title}
        </h1>
        <p className="mt-1.5 text-[12px] text-muted">{strings.header.tagline}</p>
      </div>
      <div className="hidden items-center gap-2 md:flex">
        <button
          className="inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-xs font-semibold text-muted transition hover:bg-well hover:text-primary"
          onClick={onClear}
          type="button"
        >
          <Trash2 size={13} aria-hidden="true" />
          {strings.buttons.clear}
        </button>
        {busy ? (
          <button
            className="inline-flex h-9 items-center gap-2 rounded-full bg-card/50 px-4 text-xs font-bold text-primary soft-ring transition hover:bg-elevated/60"
            onClick={onCancel}
            type="button"
          >
            {strings.buttons.cancel}
          </button>
        ) : null}
        <button
          className={clsx(
            "group inline-flex h-9 items-center gap-2 rounded-full px-4 text-xs font-bold transition",
            canConvert
              ? "bg-gradient-to-br from-accent to-accent-2 text-on-accent shadow-[0_8px_22px_rgb(var(--accent-glow)/0.32)] hover:shadow-[0_10px_28px_rgb(var(--accent-glow)/0.42)]"
              : "bg-well text-faint ring-1 ring-subtle",
          )}
          disabled={!canConvert}
          onClick={onConvert}
          type="button"
        >
          {busy ? (
            <Loader2 className="animate-spin" size={13} aria-hidden="true" />
          ) : (
            <Download size={13} aria-hidden="true" />
          )}
          {strings.buttons.start}
          <ArrowRight
            size={12}
            className={clsx("transition-transform", canConvert && "group-hover:translate-x-0.5")}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}

function Card({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <div
      className="glass-frame surface-card rounded-[16px] p-4 glass-highlight"
      data-tauri-drag-region
      id={id}
    >
      {children}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-bold leading-tight tracking-tight text-primary">{title}</h2>
        {subtitle ? <p className="mt-1 text-xs leading-relaxed text-muted">{subtitle}</p> : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}

function SidebarStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs text-muted">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-primary/85">{value}</span>
    </div>
  );
}

function SidebarItem({
  active,
  badge,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  badge?: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={clsx(
        "group flex h-10 w-full items-center justify-between rounded-xl px-3.5 text-[13px] font-semibold transition",
        active
          ? "nav-priority text-primary"
          : "text-secondary hover:bg-well/35 hover:text-primary",
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center gap-2.5">
        <span
          className={clsx(
            "transition",
            active ? "text-accent" : "text-muted group-hover:text-primary",
          )}
        >
          {icon}
        </span>
        <span>{label}</span>
      </span>
      {badge ? (
        <span className="rounded-full bg-card/55 px-2 py-0.5 text-[10px] font-bold tabular-nums text-secondary soft-ring">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function MiniStat({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "good" | "bad" | "muted";
  value: number;
}) {
  return (
    <div className="rounded-lg bg-well/30 px-2.5 py-1.5 soft-ring">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div
        className={clsx(
          "mt-0.5 text-sm font-bold tabular-nums",
          tone === "good" && "text-good",
          tone === "bad" && "text-bad",
          tone === "muted" && "text-faint",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      aria-selected={active}
      className={clsx(
        "h-7 rounded-md px-3 text-[11px] font-bold tracking-wide transition",
        active
          ? "bg-card text-primary shadow-sm"
          : "text-muted hover:text-primary",
      )}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

function SourceButton({
  active,
  description,
  icon,
  onClick,
  step,
  title,
}: {
  active: boolean;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
  step: string;
  title: string;
}) {
  return (
    <button
      aria-pressed={active}
      className={clsx(
        "accent-frame priority-action group relative flex min-h-[100px] items-stretch overflow-hidden rounded-xl p-3.5 pl-5 text-left transition",
        active
          ? "active-glow"
          : "",
      )}
      onClick={onClick}
      type="button"
    >
      <span
        className={clsx(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition",
          active
            ? "bg-card/60 text-accent"
            : "bg-card/42 text-accent",
        )}
      >
        {icon}
      </span>
      <span className="ml-3 flex min-w-0 flex-1 flex-col justify-center">
        <span className="mb-1 flex items-center gap-2">
          <span className="step-badge">{step}</span>
          <span className="truncate text-[13px] font-black text-primary">{title}</span>
        </span>
        <span className="line-clamp-2 text-[11px] leading-relaxed text-secondary">
          {description}
        </span>
      </span>
      <ArrowRight
        size={14}
        className={clsx(
          "ml-2 self-center transition",
          active
            ? "text-accent"
            : "text-faint group-hover:translate-x-0.5 group-hover:text-secondary",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function ToggleCard({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const labelId = `toggle-${label}`;
  return (
    <label
      aria-checked={checked}
      className={clsx(
        "quiet-option flex min-h-[76px] cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-subtle transition",
        checked ? "bg-card/12 active-glow" : "bg-card/10 hover:bg-card/16",
      )}
      htmlFor={labelId}
      role="switch"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-bold text-primary">{label}</span>
        <span className="mt-1 block text-[10px] leading-relaxed text-muted">
          {description}
        </span>
      </span>
      <input
        checked={checked}
        className="sr-only"
        id={labelId}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span
        className={clsx(
          "relative mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full transition",
          checked ? "bg-gradient-to-r from-accent to-accent-2" : "bg-default/35",
        )}
      >
        <span
          className={clsx(
            "absolute h-4 w-4 rounded-full bg-card/90 shadow-md transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </label>
  );
}

function JobsControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="flex min-h-[76px] items-start gap-3 rounded-xl bg-card/10 p-3 soft-ring">
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-bold text-primary">{strings.buttons.jobs}</span>
        <span className="mt-1 block text-[10px] leading-relaxed text-muted">
          {strings.buttons.jobsDesc}
        </span>
      </span>
      <div className="grid grid-cols-4 gap-1 rounded-lg bg-card/45 p-1 soft-ring">
        {[1, 2, 4, 8].map((n) => (
          <button
            aria-pressed={value === n}
            className={clsx(
              "h-7 w-8 rounded-md text-[11px] font-bold tabular-nums transition",
              value === n
                ? "bg-gradient-to-br from-accent to-accent-2 text-on-accent"
                : "text-muted hover:bg-well hover:text-primary",
            )}
            key={n}
            onClick={() => onChange(n)}
            type="button"
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function HistoryRow({
  item,
  onReveal,
}: {
  item: HistoryRecord;
  onReveal: (path: string | null) => void;
}) {
  const revealTarget = item.output ?? item.source;

  return (
    <div className="group rounded-xl bg-well/25 px-3 py-2.5 soft-ring transition hover:bg-well/40">
      <div className="flex items-center gap-3">
        <div
          className={clsx(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            item.success ? "bg-good/15 text-good" : "bg-bad/15 text-bad",
          )}
        >
          {item.success ? (
            <Check size={14} strokeWidth={3} aria-hidden="true" />
          ) : (
            <XCircle size={14} aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[13px] font-semibold text-primary">{basename(item.source)}</div>
            <span className="shrink-0 rounded-full bg-card/50 px-2 py-0.5 text-[10px] font-bold text-secondary soft-ring">
              {formatHistoryTime(item.convertedAt)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-faint">
            {item.output ? item.output : item.message}
          </div>
        </div>
        <button
          className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg bg-card/50 px-2.5 text-[11px] font-semibold text-secondary soft-ring transition hover:bg-elevated/60 hover:text-primary group-hover:inline-flex"
          onClick={() => onReveal(revealTarget)}
          type="button"
        >
          <FolderOpen size={12} aria-hidden="true" />
          {strings.buttons.reveal}
        </button>
      </div>
    </div>
  );
}

function PathRow({
  item,
  onReveal,
}: {
  item: ConversionRecord;
  onReveal: (path: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const showProgress = item.status === "converting" && item.progress != null;
  const pct = showProgress && item.progress
    ? Math.min(100, Math.max(0, Math.round((item.progress.processed / item.progress.total) * 100)))
    : 0;
  const canReveal = item.status === "done" && Boolean(item.output);
  const canExpand = item.status === "failed" && Boolean(item.message);

  return (
    <div
      className={clsx(
        "group rounded-xl px-3 py-2.5 soft-ring transition hover:bg-well/40",
        item.status === "converting" ? "bg-accent/[0.07]" : "bg-well/25",
        item.status === "failed" && "ring-1 ring-bad/20",
        item.status === "done" && "ring-1 ring-good/15",
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={clsx(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition",
            item.status === "done" && "bg-good/15 text-good",
            item.status === "failed" && "bg-bad/15 text-bad",
            item.status === "converting" && "bg-accent/15 text-accent",
            item.status === "waiting" && "bg-card text-muted",
          )}
        >
          {item.status === "converting" ? (
            <Loader2 className="animate-spin" size={14} aria-hidden="true" />
          ) : item.status === "done" ? (
            <Check size={14} strokeWidth={3} aria-hidden="true" />
          ) : item.status === "failed" ? (
            <XCircle size={14} aria-hidden="true" />
          ) : (
            <Music2 size={14} aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[13px] font-semibold text-primary">{basename(item.source)}</div>
            <StatusBadge status={item.status} />
            {showProgress ? (
              <span className="ml-auto text-[10px] font-bold tabular-nums text-accent">
                {pct}%
              </span>
            ) : null}
          </div>
          {!showProgress ? (
            <div className="mt-0.5 truncate text-[11px] text-faint">
              {item.message || item.source}
            </div>
          ) : null}
        </div>
        {canReveal ? (
          <button
            className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg bg-card/50 px-2.5 text-[11px] font-semibold text-secondary soft-ring transition hover:bg-elevated/60 hover:text-primary group-hover:inline-flex"
            onClick={() => onReveal(item.output)}
            type="button"
          >
            <FolderOpen size={12} aria-hidden="true" />
            {strings.buttons.reveal}
          </button>
        ) : null}
        {canExpand ? (
          <button
            aria-expanded={expanded}
            className="h-8 shrink-0 rounded-lg bg-card/45 px-2.5 text-[11px] font-bold text-bad soft-ring transition hover:bg-card/65"
            onClick={() => setExpanded((open) => !open)}
            type="button"
          >
            {expanded ? strings.buttons.collapse : strings.buttons.details}
          </button>
        ) : null}
      </div>
      {showProgress && item.progress ? (
        <ProgressBar progress={item.progress} />
      ) : null}
      {expanded ? (
        <div className="mt-2 ml-11 rounded-lg bg-bad/[0.08] px-3 py-2 text-[11px] leading-relaxed text-bad ring-1 ring-bad/15">
          {item.message}
        </div>
      ) : null}
    </div>
  );
}

function ProgressBar({ progress }: { progress: ProgressInfo }) {
  // EMA-smoothed throughput. We keep the previous sample on a ref so the
  // estimator survives the ~20 Hz re-render storm.
  const estimator = useRef<{ processed: number; time: number; rate: number } | null>(null);
  const [eta, setEta] = useState<string>(strings.progress.indeterminate);

  useEffect(() => {
    const now = performance.now();
    const prev = estimator.current;
    let rate = prev?.rate ?? 0;

    if (prev) {
      const dt = (now - prev.time) / 1000;
      const dBytes = progress.processed - prev.processed;
      if (dt > 0.05 && dBytes >= 0) {
        const inst = dBytes / dt;
        rate = rate === 0 ? inst : rate * 0.7 + inst * 0.3;
      }
    }

    estimator.current = { processed: progress.processed, time: now, rate };

    if (rate > 0 && progress.total > progress.processed) {
      const remaining = (progress.total - progress.processed) / rate;
      if (remaining < 1) {
        setEta(strings.progress.etaAlmostDone);
      } else if (remaining < 60) {
        setEta(strings.progress.etaSeconds(Math.round(remaining)));
      } else {
        const m = Math.floor(remaining / 60);
        const s = Math.round(remaining % 60);
        setEta(strings.progress.etaMinutes(m, s));
      }
    } else {
      setEta(strings.progress.indeterminate);
    }
  }, [progress.processed, progress.total]);

  const pct = Math.min(
    100,
    Math.max(0, Math.round((progress.processed / progress.total) * 100)),
  );

  return (
    <div className="mt-2 ml-11">
      <div
        aria-label="progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={pct}
        className="h-1.5 w-full overflow-hidden rounded-full bg-card/55 soft-ring"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-faint">
        <span>
          {formatBytes(progress.processed)} / {formatBytes(progress.total)}
        </span>
        <span>{eta}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ConversionStatus }) {
  const label = {
    waiting: strings.status.waiting,
    converting: strings.status.converting,
    done: strings.status.done,
    failed: strings.status.failed,
  }[status];

  return (
    <span
      className={clsx(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold soft-ring",
        status === "waiting" && "bg-card/50 text-secondary",
        status === "converting" && "bg-accent/12 text-accent ring-accent/25",
        status === "done" && "bg-good/12 text-good ring-good/25",
        status === "failed" && "bg-bad/12 text-bad ring-bad/25",
      )}
    >
      {label}
    </span>
  );
}

function MobileActions({
  busy,
  canConvert,
  onConvert,
  onClear,
}: {
  busy: boolean;
  canConvert: boolean;
  onConvert: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2 sm:flex-row md:hidden">
      <button
        className={clsx(
          "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition",
          canConvert
            ? "bg-gradient-to-br from-accent to-accent-2 text-on-accent shadow-[0_8px_22px_rgb(var(--accent-glow)/0.32)]"
            : "bg-well text-faint",
        )}
        disabled={!canConvert}
        onClick={onConvert}
        type="button"
      >
        {busy ? (
          <Loader2 className="animate-spin" size={15} aria-hidden="true" />
        ) : (
          <Download size={15} aria-hidden="true" />
        )}
        {strings.buttons.start}
      </button>
      <button
        className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-card/50 px-4 text-sm font-semibold text-secondary soft-ring transition hover:bg-elevated/60 hover:text-primary"
        onClick={onClear}
        type="button"
      >
        <Trash2 size={15} aria-hidden="true" />
        {strings.buttons.clear}
      </button>
    </div>
  );
}
