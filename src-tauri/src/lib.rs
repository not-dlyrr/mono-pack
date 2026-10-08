mod engine;
#[cfg(test)]mod image_verification;
mod process_guard;
#[cfg(test)]
mod verification;
use engine::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    name: String,
    settings: Settings,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Store {
    #[serde(default)]
    revision: u64,
    jobs: Vec<Job>,
    presets: Vec<Preset>,
}
struct Shared {
    sequence: AtomicU64,
    store: Mutex<Store>,
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
    file: PathBuf,
    ffmpeg: PathBuf,
    fault: Mutex<Option<String>>,
}
type State = Arc<Shared>;
fn persist(state: &Shared, store: &Store) -> Result<(), String> {
    let tmp = state.file.with_extension("tmp");
    let mut snapshot = store.clone();
    snapshot.revision = state.sequence.load(Ordering::Relaxed);
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(tmp, &state.file).map_err(|e| e.to_string())?;
    fs::File::create(state.file.with_file_name("journal.jsonl"))
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
#[derive(Serialize, Deserialize)]
struct Record {
    sequence: u64,
    id: String,
    index: usize,
    item: Item,
}
fn journal(state: &Shared, id: &str, index: usize, item: &Item) -> Result<(), String> {
    use std::io::Write;
    let record = Record {
        sequence: state.sequence.fetch_add(1, Ordering::Relaxed) + 1,
        id: id.into(),
        index,
        item: item.clone(),
    };
    let mut bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.file.with_file_name("journal.jsonl"))
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn update_item(state: &Shared, id: &str, index: usize, item: &Item) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    if let Some(job) = store.jobs.iter_mut().find(|j| j.id == id) {
        job.items[index] = item.clone();
    }
    journal(state, id, index, item)
}
fn replay(store: &mut Store, path: &Path) -> Result<u64, String> {
    use std::io::BufRead;
    let mut last = store.revision;
    if path.exists() {
        for line in
            std::io::BufReader::new(fs::File::open(path).map_err(|e| e.to_string())?).lines()
        {
            let line = line.map_err(|e| e.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let record: Record = serde_json::from_str(&line).map_err(|e| {
                format!("Job journal is damaged: {}. Preserve it before repair.", e)
            })?;
            last = last.max(record.sequence);
            if record.sequence > store.revision {
                if let Some(job) = store.jobs.iter_mut().find(|j| j.id == record.id) {
                    if let Some(item) = job.items.get_mut(record.index) {
                        *item = record.item;
                    }
                }
            }
        }
    }
    Ok(last)
}
fn saved(state: &Shared, store: &Store) {
    if let Err(e) = persist(state, store) {
        *state.fault.lock().unwrap() = Some(format!(
            "Cannot save job history: {}. Stop processing and check disk space.",
            e
        ));
    }
}
#[tauri::command]
async fn choose_files() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Add files to Mono Pack")
            .pick_files()
            .unwrap_or_default()
            .iter()
            .map(|p| p.to_string_lossy().into())
            .collect()
    })
    .await
    .unwrap_or_default()
}
#[tauri::command]
async fn choose_folder() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose output folder")
            .pick_folder()
            .map(|p| p.to_string_lossy().into())
    })
    .await
    .unwrap_or_default()
}
#[tauri::command]
async fn preview_files(paths: Vec<String>, settings: Settings) -> Result<Vec<Item>, String> {
    tauri::async_runtime::spawn_blocking(move || preview(paths, &settings))
        .await
        .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    jobs: Vec<Job>,
    presets: Vec<Preset>,
    fault: Option<String>,
    engine_ready: bool,
}
#[tauri::command]
fn snapshot(state: tauri::State<State>) -> Snapshot {
    let store = state.store.lock().unwrap();
    Snapshot {
        jobs: store.jobs.clone(),
        presets: store.presets.clone(),
        fault: state.fault.lock().unwrap().clone(),
        engine_ready: state.ffmpeg.exists(),
    }
}
#[tauri::command]
fn enqueue(
    items: Vec<Item>,
    settings: Settings,
    state: tauri::State<State>,
) -> Result<String, String> {
    validate(&settings)?;
    if state.fault.lock().unwrap().is_some() {
        return Err("Resolve the history storage error before running another job.".into());
    }
    if items.is_empty() {
        return Err("Preview files first.".into());
    }
    let fresh = preview(items.iter().map(|i| i.source.clone()).collect(), &settings)?;
    if fresh.len() != items.len()
        || fresh
            .iter()
            .zip(&items)
            .any(|(a, b)| a.output != b.output || a.bytes != b.bytes)
    {
        return Err("Files or output names changed. Refresh the preview before running.".into());
    }
    if fresh.iter().all(|i| i.error.is_some()) {
        return Err("No valid files in this batch.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let job = Job {
        id: id.clone(),
        items: fresh,
        settings,
        status: "queued".into(),
        created: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        undo: false,
    };
    let mut store = state.store.lock().unwrap();
    if store.jobs.len() >= 200 {
        return Err("History contains 200 jobs. Clear finished history before adding more.".into());
    }
    store.jobs.push(job);
    if let Err(e) = persist(&state, &store) {
        store.jobs.pop();
        return Err(e);
    }
    state
        .cancel
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::new(AtomicBool::new(false)));
    Ok(id)
}
#[tauri::command]
fn cancel_job(id: String, state: tauri::State<State>) -> Result<(), String> {
    let mut flags = state.cancel.lock().unwrap();
    flags
        .entry(id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn save_preset(name: String, settings: Settings, state: tauri::State<State>) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 60 {
        return Err("Use a preset name between 1 and 60 characters.".into());
    }
    let mut store = state.store.lock().unwrap();
    store.presets.retain(|p| p.name != name.trim());
    store.presets.push(Preset {
        name: name.trim().into(),
        settings,
    });
    persist(&state, &store)
}
#[tauri::command]
fn delete_preset(name: String, state: tauri::State<State>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    store.presets.retain(|p| p.name != name);
    persist(&state, &store)
}
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.is_dir() {
        return Err("Output folder does not exist yet.".into());
    }
    hidden_command(Path::new("explorer.exe"))
        .arg(p)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn export_undo(id: String, state: tauri::State<'_, State>) -> Result<(), String> {
    let job = state
        .store
        .lock()
        .unwrap()
        .jobs
        .iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or("Job not found")?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = rfd::FileDialog::new()
            .set_file_name("mono-pack-undo.json")
            .save_file()
        {
            fs::write(
                path,
                serde_json::to_vec_pretty(&job).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn undo_job(id: String, state: tauri::State<'_, State>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut job = {
            let mut store = state.store.lock().unwrap();
            if store
                .jobs
                .iter()
                .any(|j| j.status == "running" || j.status == "undoing")
            {
                return Err("Wait for running jobs to finish before undoing.".into());
            }
            let job = store
                .jobs
                .iter_mut()
                .find(|j| j.id == id)
                .ok_or("Job not found")?;
            if job.settings.operation != "rename" || job.undo {
                return Err("This job cannot be undone.".into());
            }
            job.status = "undoing".into();
            let copy = job.clone();
            persist(&state, &store)?;
            copy
        };
        let mut failures = 0;
        for index in 0..job.items.len() {
            let i = &mut job.items[index];
            if i.status == "done" {
                match undo_item(i, job.settings.in_place) {
                    Ok(()) => {
                        i.status = "undone".into();
                        i.error = None
                    }
                    Err(e) => {
                        failures += 1;
                        i.error = Some(e)
                    }
                }
                update_item(&state, &id, index, &job.items[index])?;
            }
        }
        job.undo = failures == 0;
        job.status = if failures == 0 {
            "undone"
        } else {
            "undo_partial"
        }
        .into();
        let mut store = state.store.lock().unwrap();
        *store.jobs.iter_mut().find(|j| j.id == id).unwrap() = job;
        persist(&state, &store)?;
        Ok(if failures == 0 {
            "Rename undone.".into()
        } else {
            format!("{} files could not be undone. See file errors.", failures)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn clear_history(state: tauri::State<State>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    store.jobs.retain(|j| {
        ["queued", "running", "undoing"].contains(&j.status.as_str())
            || (j.settings.operation == "rename"
                && !j.undo
                && j.items.iter().any(|i| i.status == "done"))
    });
    persist(&state, &store)
}
fn worker(state: State) {
    loop {
        let next = {
            let mut store = state.store.lock().unwrap();
            if store.jobs.iter().any(|j| j.status == "undoing") {
                None
            } else {
                let job = store.jobs.iter_mut().find(|j| j.status == "queued");
                let copy = job.map(|j| {
                    j.status = "running".into();
                    j.clone()
                });
                if copy.is_some() {
                    saved(&state, &store)
                }
                copy
            }
        };
        let Some(mut job) = next else {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        };
        let cancel = state
            .cancel
            .lock()
            .unwrap()
            .entry(job.id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        for index in 0..job.items.len() {
            if job.items[index].status == "invalid" {
                continue;
            }
            if cancel.load(Ordering::Relaxed) {
                job.items[index].status = "cancelled".into();
                continue;
            }
            let item = job.items[index].clone();
            job.items[index].status = "running".into();
            if let Err(e) = update_item(&state, &job.id, index, &job.items[index]) {
                *state.fault.lock().unwrap() = Some(e);
                cancel.store(true, Ordering::Relaxed);
                job.items[index].status = "cancelled".into();
                continue;
            }
            let result = (|| {
                fs::create_dir_all(Path::new(&item.output).parent().unwrap())
                    .map_err(|e| e.to_string())?;
                if Path::new(&item.output).exists() {
                    return Err(
                        "Output collision appeared after preview. Refresh the preview and retry."
                            .into(),
                    );
                }
                let mut progress = |p| {
                    let mut store = state.store.lock().unwrap();
                    if let Some(j) = store.jobs.iter_mut().find(|j| j.id == job.id) {
                        j.items[index].progress = p;
                    }
                };
                if job.settings.operation == "rename" {
                    let hash = fingerprint_cancel(Path::new(&item.source), &cancel)?;
                    job.items[index].hash = Some(hash);
                    update_item(&state, &job.id, index, &job.items[index])?;
                    copy_progress(
                        Path::new(&item.source),
                        Path::new(&item.temp),
                        &cancel,
                        &mut progress,
                    )?;
                    if cancel.load(Ordering::Relaxed) {
                        return Err("Cancelled".into());
                    }
                    commit(Path::new(&item.temp), Path::new(&item.output))?;
                    job.items[index].status = "done".into();
                    update_item(&state, &job.id, index, &job.items[index])?;
                    if job.settings.in_place {
                        if fingerprint_cancel(Path::new(&item.source), &cancel)?
                            != job.items[index].hash.clone().unwrap()
                        {
                            return Err("Source changed while copying; original preserved. Output has an undo record.".into());
                        }
                        fs::remove_file(&item.source).map_err(|e| {
                            format!("Output created, but original could not be removed: {}", e)
                        })?;
                    }
                    Ok(())
                } else if job.settings.operation == "image" {
                    image_process(&item, &job.settings, &cancel, &mut progress)
                } else {
                    media_process(&item, &job.settings, &state.ffmpeg, &cancel, &mut progress)
                }
            })();
            let out = &mut job.items[index];
            match result {
                Ok(()) => {
                    out.status = "done".into();
                    out.progress = 100.;
                    out.output_bytes = fs::metadata(&out.output).map(|m| m.len()).unwrap_or(0)
                }
                Err(e) => {
                    out.status = if job.settings.operation == "rename"
                        && out.hash.is_some()
                        && Path::new(&out.output).exists()
                        && fingerprint(Path::new(&out.output)).ok().as_ref() == out.hash.as_ref()
                    {
                        "done"
                    } else if e == "Cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    out.error = Some(e);
                }
            }
            let _ = fs::remove_file(&out.temp);
            if let Err(e) = update_item(&state, &job.id, index, &job.items[index]) {
                *state.fault.lock().unwrap() = Some(e);
            }
            if state.fault.lock().unwrap().is_some() {
                cancel.store(true, Ordering::Relaxed);
            }
        }
        job.status = if cancel.load(Ordering::Relaxed) {
            "cancelled"
        } else if job
            .items
            .iter()
            .any(|i| i.status == "failed" || i.status == "invalid")
        {
            "completed_with_errors"
        } else {
            "completed"
        }
        .into();
        let mut store = state.store.lock().unwrap();
        *store.jobs.iter_mut().find(|j| j.id == job.id).unwrap() = job.clone();
        saved(&state, &store);
    }
}
fn recover(store: &mut Store) {
    for job in &mut store.jobs {
        if ["running", "queued", "undoing"].contains(&job.status.as_str()) {
            job.status = "interrupted".into();
            for item in &mut job.items {
                if item.status == "running"
                    && job.settings.operation == "rename"
                    && item.hash.is_some()
                    && Path::new(&item.output).exists()
                {
                    if fingerprint(Path::new(&item.output)).ok().as_ref() == item.hash.as_ref() {
                        item.status = "done".into();
                        item.error = Some(
                            "Interrupted rename. Check original and use Undo if needed.".into(),
                        );
                    }
                }
                if ["running", "pending"].contains(&item.status.as_str()) {
                    item.status = "interrupted".into();
                    item.error=Some("Application closed before completion. Original preserved; add the file again to retry.".into());
                }
                let _ = fs::remove_file(&item.temp);
            }
        }
    }
}
#[tauri::command]
fn set_liquid_glass(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    // The webview can reveal its own rendered content, never the desktop.
    let _ = on;
    #[cfg(windows)]
    {
        let _ = window_vibrancy::clear_mica(&window);
        let _ = window_vibrancy::clear_acrylic(&window);
    }
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(window)=app.get_webview_window("main"){let _=window.set_focus();}})).setup(|app|{let dir=app.path().app_data_dir()?;fs::create_dir_all(&dir)?;let file=dir.join("history.json");let mut fault=None;let mut store=if file.exists(){match fs::read(&file).ok().and_then(|b|serde_json::from_slice::<Store>(&b).ok()){Some(s)=>s,None=>{fault=Some("Job history could not be read. Preserve history.json and repair it before running more jobs.".into());Store::default()}}}else{Store::default()};let sequence=match replay(&mut store,&dir.join("journal.jsonl")){Ok(n)=>n,Err(e)=>{fault=Some(e);store.revision}};recover(&mut store);let resource=app.path().resource_dir()?.join("resources/ffmpeg.exe");let ffmpeg=if cfg!(debug_assertions)&&!resource.exists(){PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ffmpeg.exe")}else{resource};let shared=Arc::new(Shared{sequence:AtomicU64::new(sequence),store:Mutex::new(store),cancel:Mutex::new(HashMap::new()),file,ffmpeg,fault:Mutex::new(fault)});if shared.fault.lock().unwrap().is_none(){persist(&shared,&shared.store.lock().unwrap()).map_err(std::io::Error::other)?;}app.manage(shared.clone());std::thread::spawn(move||worker(shared));Ok(())}).invoke_handler(tauri::generate_handler![set_liquid_glass,choose_files,choose_folder,preview_files,snapshot,enqueue,cancel_job,save_preset,delete_preset,open_folder,undo_job,export_undo,clear_history]).build(tauri::generate_context!()).expect("Cannot start Mono Pack").run(|handle,event|{if matches!(event,tauri::RunEvent::ExitRequested{..}){let state=handle.state::<State>();for flag in state.cancel.lock().unwrap().values(){flag.store(true,Ordering::Relaxed);}}});
}
