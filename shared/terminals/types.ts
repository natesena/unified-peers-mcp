/**
 * Terminal adapter contract.
 *
 * Each terminal emulator we want to specialize for gets one TerminalAdapter
 * implementation. The broker picks the right adapter per peer via
 * getAdapter(peer.terminal_program) in shared/terminals/index.ts; unknown
 * TERM_PROGRAM values fall through to the generic adapter.
 *
 * To add a specialized adapter:
 *   1. Create shared/terminals/<name>.ts implementing this interface.
 *   2. Register it in shared/terminals/index.ts under its TERM_PROGRAM key.
 *
 * Contract for every method below: no-throw, silent-fail, no-op on null/blank
 * tty. Callers fire-and-forget — title hygiene is best-effort, never blocking.
 */
export interface TerminalAdapter {
  /** Adapter identifier (e.g. "ghostty", "generic"). For diagnostics; not used for lookup. */
  readonly name: string;

  /**
   * Set the terminal window/tab title.
   *
   * `tty` is the bare device name (e.g. "ttys005") as captured by ps;
   * the adapter prefixes "/dev/" itself. If `tty` is null or empty,
   * the call is a no-op.
   *
   * Never throws. Permission errors, closed-tty errors, and any other
   * I/O failures are swallowed silently — title rendering is best-effort.
   */
  writeTitle(tty: string | null, title: string): Promise<void>;

  /**
   * Reset the terminal title (empty OSC 2). After this, the shell's next
   * prompt callback (if any) will set its own title; otherwise the title
   * falls back to whatever the terminal emulator considers default.
   *
   * Same no-throw contract as writeTitle.
   */
  clearTitle(tty: string | null): Promise<void>;

  /**
   * Tint the terminal background to the given #rrggbb color, or reset to
   * the terminal's default when `color` is null. Used today for per-team
   * color signaling so panes for different teams are obvious at a glance
   * (especially in Mission Control thumbnails).
   *
   * The generic adapter no-ops this — only terminals known to honor a
   * dynamic background sequence (Ghostty via OSC 11) actually emit bytes.
   * Same fire-and-forget / no-throw / no-op-on-blank-tty contract as
   * writeTitle.
   */
  setBackground(tty: string | null, color: string | null): Promise<void>;
}
