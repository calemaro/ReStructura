// Everything the frontend asks Rust for, in one place.
//
// `window.__TAURI__` exists only inside the desktop app (tauri.conf.json:
// withGlobalTauri). In a plain browser every call rejects with a clear message.

const tauri = window.__TAURI__;
const notDesktop = () => Promise.reject(new Error("Not running inside the desktop app"));
const invoke = tauri ? tauri.core.invoke : notDesktop;

/** Turn an absolute file path into a URL the webview may load (Tauri's asset protocol). */
export const fileUrl = (absPath) => (tauri ? tauri.core.convertFileSrc(absPath) : absPath);

// ---- projects ------------------------------------------------------------------------
export const listProjects   = ()          => invoke("list_projects");
export const createProject  = (name)      => invoke("create_project", { name });
export const openProject    = (slug)      => invoke("open_project", { slug });
export const currentProject = ()          => invoke("current_project");
export const closeProject   = ()          => invoke("close_project");
export const deleteProject  = (slug)      => invoke("delete_project", { slug });
export const exportProject  = (slug, dest)=> invoke("export_project", { slug, dest });
export const importProject  = (zipPath)   => invoke("import_project", { zipPath });
export const projectsDir    = ()          => invoke("projects_dir");
export const setColourScheme= (scheme)    => invoke("set_colour_scheme", { scheme });

// ---- levels --------------------------------------------------------------------------
export const listLevels = ()               => invoke("list_levels");
export const importPlan = (srcPath, name)  => invoke("import_plan", { srcPath, name });

// ---- pins ----------------------------------------------------------------------------
export const listPins   = (levelId)                    => invoke("list_pins", { levelId });
export const addPin     = (levelId, x, y, label, notes, category = "other") => invoke("add_pin", { levelId, x, y, label, notes, category });
export const updatePin  = (id, label, notes, category)  => invoke("update_pin", { id, label, notes, category });
export const restorePin = (pin)                        => invoke("restore_pin", { pin });
export const deletePin  = (id)                         => invoke("delete_pin", { id });

// ---- measurements --------------------------------------------------------------------
export const listMeasurements = (pinId)       => invoke("list_measurements", { pinId });
export const setMeasurements  = (pinId, list) => invoke("set_measurements", { pinId, list });

// ---- native file dialogs (tauri-plugin-dialog) ---------------------------------------
const dialog = tauri?.dialog;
export async function pickImage(title) {
  if (!dialog) return notDesktop();
  return dialog.open({ title, multiple: false, directory: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
}
export async function pickZip(title) {
  if (!dialog) return notDesktop();
  return dialog.open({ title, multiple: false, directory: false,
    filters: [{ name: "Project archive", extensions: ["zip"] }] });
}
export async function pickSavePath(title, defaultName) {
  if (!dialog) return notDesktop();
  return dialog.save({ title, defaultPath: defaultName,
    filters: [{ name: "Project archive", extensions: ["zip"] }] });
}
