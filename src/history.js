// Undo / redo.
//
// Every change to the project goes through `run(command)` instead of calling
// Rust directly. A command is a plain object with two async functions:
//
//   { label: "delete pin", do: async () => {...}, undo: async () => {...} }
//
// `do` is executed immediately and the command is pushed on the undo stack.
// Ctrl+Z pops it and runs `undo`; Ctrl+Shift+Z runs `do` again. Any new
// command clears the redo stack, as in every editor.
//
// Commands may also define `merge(next)`: if it returns true, `next` has been
// absorbed into this command and is not pushed separately. Autosaved typing
// uses this so one Ctrl+Z reverts a whole edit, not one keystroke.

const undoStack = [];
const redoStack = [];
const listeners = new Set();
let busy = false;

function notify() {
  const state = { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0,
                  undoLabel: undoStack.at(-1)?.label, redoLabel: redoStack.at(-1)?.label };
  listeners.forEach((fn) => fn(state));
}

export function onChange(fn) { listeners.add(fn); fn({ canUndo: false, canRedo: false }); return () => listeners.delete(fn); }

export async function run(cmd) {
  if (busy) throw new Error("history: another command is still running");
  busy = true;
  try {
    await cmd.do();
    const top = undoStack.at(-1);
    if (!(top && top.merge && top.merge(cmd))) undoStack.push(cmd);
    redoStack.length = 0;
  } finally { busy = false; }
  notify();
}

export async function undo() {
  const cmd = undoStack.pop();
  if (!cmd || busy) return;
  busy = true;
  try { await cmd.undo(); redoStack.push(cmd); }
  catch (err) { undoStack.push(cmd); throw err; }   // leave the stack as it was
  finally { busy = false; }
  notify();
}

export async function redo() {
  const cmd = redoStack.pop();
  if (!cmd || busy) return;
  busy = true;
  try { await cmd.do(); undoStack.push(cmd); }
  catch (err) { redoStack.push(cmd); throw err; }
  finally { busy = false; }
  notify();
}

export function clear() { undoStack.length = 0; redoStack.length = 0; notify(); }

/** True when the keyboard focus is somewhere that has its own undo (text fields). */
export function focusIsInTextField() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}
