use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub operation: String,
    pub format: String,
    pub quality: u8,
    pub width: u32,
    pub height: u32,
    pub strip_metadata: bool,
    pub output_folder: String,
    pub find: String,
    pub replace: String,
    pub prefix: String,
    pub suffix: String,
    pub numbering: bool,
    pub start: u32,
    pub digits: u8,
    pub in_place: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            operation: "image".into(),
            format: "webp".into(),
            quality: 80,
            width: 0,
            height: 0,
            strip_metadata: true,
            output_folder: String::new(),
            find: String::new(),
            replace: String::new(),
            prefix: String::new(),
            suffix: String::new(),
            numbering: false,
            start: 1,
            digits: 3,
            in_place: false,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub source: String,
    pub output: String,
    pub bytes: u64,
    pub status: String,
    pub progress: f64,
    pub error: Option<String>,
    pub output_bytes: u64,
    pub hash: Option<String>,
    pub temp: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub settings: Settings,
    pub items: Vec<Item>,
    pub status: String,
    pub created: u64,
    pub undo: bool,
}

pub fn fingerprint(path: &Path) -> Result<String, String> {
    fingerprint_cancel(path, &AtomicBool::new(false))
}
pub fn fingerprint_cancel(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && !name.ends_with([' ', '.'])
        && !name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
        && ![
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&name.split('.').next().unwrap_or("").to_uppercase().as_str())
}
pub fn validate(s: &Settings) -> Result<(), String> {
    if !["image", "video", "audio", "rename"].contains(&s.operation.as_str()) {
        return Err("Choose a supported operation.".into());
    }
    let formats = match s.operation.as_str() {
        "image" => vec!["png", "jpeg", "webp"],
        "video" => vec!["mp4", "webm"],
        "audio" => vec!["wav", "mp3", "m4a"],
        _ => vec![s.format.as_str()],
    };
    if !formats.contains(&s.format.as_str()) {
        return Err("Choose a supported output format.".into());
    }
    if s.quality < 1
        || s.quality > 100
        || s.width > 16384
        || s.height > 16384
        || s.digits > 9
        || s.digits < 1
    {
        return Err("Quality must be 1–100, dimensions 0–16384, numbering width 1–9.".into());
    }
    if s.output_folder.is_empty() && !(s.operation == "rename" && s.in_place) {
        return Err("Choose an output folder.".into());
    }
    Ok(())
}
pub fn preview(paths: Vec<String>, s: &Settings) -> Result<Vec<Item>, String> {
    validate(s)?;
    if paths.is_empty() || paths.len() > 10000 {
        return Err("Add between 1 and 10,000 files.".into());
    }
    let mut taken = HashSet::new();
    let mut sources = HashSet::new();
    let mut items = vec![];
    for (index, raw) in paths.into_iter().enumerate() {
        let src = PathBuf::from(&raw);
        if !src.is_absolute() {
            return Err("Use absolute file paths.".into());
        }
        let canon = fs::canonicalize(&src).map_err(|e| format!("{}: {}", src.display(), e))?;
        if !sources.insert(canon.to_string_lossy().to_lowercase()) {
            continue;
        }
        let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err(format!("{} is not a file.", src.display()));
        }
        let ext = src
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let mut error = None;
        if s.operation == "image" && !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
            error = Some("Not a supported image. Choose PNG, JPEG, or WebP.".into())
        }
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        let output_ext = if s.operation == "rename" {
            src.extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default()
        } else {
            format!(".{}", if s.format == "jpeg" { "jpg" } else { &s.format })
        };
        let name = if s.operation == "rename" {
            format!(
                "{}{}{}{}{}",
                s.prefix,
                if s.find.is_empty() {
                    stem.to_string()
                } else {
                    stem.replace(&s.find, &s.replace)
                },
                if s.numbering {
                    format!(
                        "{:0width$}",
                        s.start as u64 + index as u64,
                        width = s.digits as usize
                    )
                } else {
                    String::new()
                },
                s.suffix,
                output_ext
            )
        } else {
            format!("{}{}", stem, output_ext)
        };
        if !valid_name(&name) {
            error=Some("Result is not a valid Windows filename. Remove reserved names, punctuation, or trailing dots/spaces.".into())
        }
        let folder = if s.operation == "rename" && s.in_place {
            src.parent().unwrap().to_path_buf()
        } else {
            PathBuf::from(&s.output_folder)
        };
        if !folder.is_absolute() {
            return Err("Output folder must be absolute.".into());
        }
        let mut out = folder.join(&name);
        let base = out
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = out
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut n = 2;
        while out.exists() || taken.contains(&out.to_string_lossy().to_lowercase()) {
            out = folder.join(format!("{} ({}){}", base, n, ext));
            n += 1;
        }
        taken.insert(out.to_string_lossy().to_lowercase());
        let temp = folder.join(format!(".mono-{}-{}.part", uuid::Uuid::new_v4(), index));
        items.push(Item {
            source: raw,
            output: out.to_string_lossy().into(),
            bytes: meta.len(),
            status: if error.is_some() {
                "invalid"
            } else {
                "pending"
            }
            .into(),
            progress: 0.,
            error,
            output_bytes: 0,
            hash: None,
            temp: temp.to_string_lossy().into(),
        });
    }
    Ok(items)
}
pub fn hidden_command(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
pub fn copy_exclusive(src: &Path, dst: &Path, cancel: &AtomicBool) -> Result<(), String> {
    copy_progress(src, dst, cancel, &mut |_| {})
}
pub fn copy_progress(
    src: &Path,
    dst: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let mut input = File::open(src).map_err(|e| e.to_string())?;
    let total = input.metadata().map_err(|e| e.to_string())?.len();
    let mut written = 0u64;
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)
        .map_err(|e| format!("Output exists or cannot be created: {}", e))?;
    let mut buf = [0; 262144];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        written += n as u64;
        if total > 0 {
            progress((written as f64 / total as f64 * 95.).min(95.));
        }
    }
    out.sync_all().map_err(|e| e.to_string())
}
pub fn commit(temp: &Path, dst: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let src: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let out: Vec<u16> = dst.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(src.as_ptr(), out.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(format!(
                "Cannot publish output without overwriting: {}",
                std::io::Error::last_os_error()
            ));
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(temp, dst).map_err(|e| {
            format!(
                "Cannot publish output (a collision may have appeared): {}",
                e
            )
        })?;
        fs::remove_file(temp).map_err(|e| e.to_string())
    }
}
pub fn image_process(
    item: &Item,
    s: &Settings,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let reader = image::ImageReader::open(&item.source)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    let mut reader = reader;
    reader.limits(limits);
    use image::ImageDecoder;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Cannot decode image: {}", e))?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut im = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("Cannot decode image: {}", e))?;
    im.apply_orientation(orientation);
    progress(20.);
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    if s.width > 0 || s.height > 0 {
        let w = if s.width == 0 {
            ((im.width() as f64 * s.height as f64 / im.height() as f64).round() as u32).max(1)
        } else {
            s.width
        };
        let h = if s.height == 0 {
            ((im.height() as f64 * s.width as f64 / im.width() as f64).round() as u32).max(1)
        } else {
            s.height
        };
        im = im.resize(w, h, image::imageops::FilterType::Lanczos3);
    }
    progress(55.);
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&item.temp)
        .map_err(|e| e.to_string())?;
    match s.format.as_str() {
        "jpeg" => {
            let rgba = im.to_rgba8();
            let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
            for (x, y, p) in rgba.enumerate_pixels() {
                let a = p[3] as u32;
                rgb.put_pixel(
                    x,
                    y,
                    image::Rgb([
                        ((p[0] as u32 * a + 255 * (255 - a)) / 255) as u8,
                        ((p[1] as u32 * a + 255 * (255 - a)) / 255) as u8,
                        ((p[2] as u32 * a + 255 * (255 - a)) / 255) as u8,
                    ]),
                );
            }
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, s.quality)
                .encode_image(&rgb)
                .map_err(|e| e.to_string())?
        }
        "webp" => {
            let rgba = im.to_rgba8();
            let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
            let data = encoder.encode(s.quality as f32);
            output.write_all(&data).map_err(|e| e.to_string())?
        }
        _ => {
            use image::ImageEncoder;
            let rgba = im.to_rgba8();
            image::codecs::png::PngEncoder::new_with_quality(
                &mut output,
                image::codecs::png::CompressionType::Best,
                image::codecs::png::FilterType::Adaptive,
            )
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?
        }
    }
    output.sync_all().map_err(|e| e.to_string())?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    commit(Path::new(&item.temp), Path::new(&item.output))
}

pub fn media_process(
    item: &Item,
    s: &Settings,
    ffmpeg: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let probe = ffmpeg.with_file_name("ffprobe.exe");
    let mut probe_child = hidden_command(&probe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(&item.source)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Media engine unavailable: {}", e))?;
    let _probe_guard = match super::process_guard::Guard::attach(&probe_child) {
        Ok(g) => g,
        Err(e) => {
            let _ = probe_child.kill();
            let _ = probe_child.wait();
            return Err(e);
        }
    };
    let stdout = probe_child.stdout.take().unwrap();
    let stderr = probe_child.stderr.take().unwrap();
    let out_thread = thread::spawn(move || {
        let mut bytes = vec![];
        let _ = stdout.take(65536).read_to_end(&mut bytes);
        bytes
    });
    let err_thread = thread::spawn(move || {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            tail.push_str(&line);
            if tail.len() > 16000 {
                tail = tail
                    .chars()
                    .rev()
                    .take(8000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
        }
        tail
    });
    let began = std::time::Instant::now();
    let status = loop {
        if cancel.load(Ordering::Relaxed) || began.elapsed() > Duration::from_secs(30) {
            let _ = probe_child.kill();
            let _ = probe_child.wait();
            let _ = out_thread.join();
            let _ = err_thread.join();
            return Err(if cancel.load(Ordering::Relaxed) {
                "Cancelled".into()
            } else {
                "Media probing timed out after 30 seconds.".into()
            });
        }
        match probe_child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(e) => {
                let _ = probe_child.kill();
                return Err(e.to_string());
            }
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("Cannot read media: {}", stderr.trim()));
    }
    let duration = String::from_utf8_lossy(&stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(0.);
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    let mut args = vec![
        "-nostdin".to_string(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-n".into(),
        "-i".into(),
        item.source.clone(),
        "-progress".into(),
        "pipe:1".into(),
        "-threads".into(),
        "2".into(),
    ];
    if s.strip_metadata {
        args.extend([
            "-map_metadata".into(),
            "-1".into(),
            "-map_chapters".into(),
            "-1".into(),
        ]);
    }
    if s.operation == "audio" {
        args.extend(["-map".into(), "0:a:0".into(), "-vn".into()]);
        match s.format.as_str() {
            "mp3" => args.extend([
                "-c:a".into(),
                "libmp3lame".into(),
                "-q:a".into(),
                ((100 - s.quality) / 12).to_string(),
                "-f".into(),
                "mp3".into(),
            ]),
            "m4a" => args.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
                "-f".into(),
                "ipod".into(),
            ]),
            _ => args.extend(["-c:a".into(), "pcm_s16le".into(), "-f".into(), "wav".into()]),
        }
    } else {
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "0:a:0?".into(),
        ]);
        let w = if s.width == 0 {
            "iw".into()
        } else {
            s.width.to_string()
        };
        let h = if s.height == 0 {
            "ih".into()
        } else {
            s.height.to_string()
        };
        args.extend(["-vf".into(),format!("scale={}:{}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",w,h)]);
        if s.format == "mp4" {
            args.extend([
                "-c:v".into(),
                "mpeg4".into(),
                "-q:v".into(),
                (2 + (100 - s.quality) / 4).to_string(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "160k".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-f".into(),
                "mp4".into(),
            ]);
        } else {
            args.extend([
                "-c:v".into(),
                "libvpx-vp9".into(),
                "-crf".into(),
                (15 + (100 - s.quality) / 2).to_string(),
                "-b:v".into(),
                "0".into(),
                "-deadline".into(),
                "realtime".into(),
                "-cpu-used".into(),
                "5".into(),
                "-c:a".into(),
                "libopus".into(),
                "-f".into(),
                "webm".into(),
            ]);
        }
    }
    args.push(item.temp.clone());
    let mut child = hidden_command(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let _guard = match super::process_guard::Guard::attach(&child) {
        Ok(g) => g,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(t) = line
                .strip_prefix("out_time_us=")
                .and_then(|s| s.parse::<f64>().ok())
            {
                let _ = tx.send(t);
            }
        }
    });
    let errors = thread::spawn(move || {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 16000 {
                tail = tail
                    .chars()
                    .rev()
                    .take(8000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
        }
        tail
    });
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        for t in rx.try_iter() {
            if duration > 0. {
                progress((t / 1_000_000. / duration * 100.).clamp(0., 99.));
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(80)),
            Err(e) => {
                let _ = child.kill();
                return Err(e.to_string());
            }
        }
    };
    let _ = reader.join();
    let error = errors.join().unwrap_or_default();
    match status {
        None => Err("Cancelled".into()),
        Some(status) if !status.success() => Err(if error.is_empty() {
            "Media conversion failed.".into()
        } else {
            error
        }),
        _ => {
            if cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            commit(Path::new(&item.temp), Path::new(&item.output))
        }
    }
}

pub fn undo_item(item: &Item, in_place: bool) -> Result<(), String> {
    let output = Path::new(&item.output);
    let expected = item
        .hash
        .as_ref()
        .ok_or("No verified undo record for this file.")?;
    if !output.exists() {
        return Err("Output is missing; undo skipped.".into());
    }
    if &fingerprint(output)? != expected {
        return Err("Output changed since processing; undo skipped to protect it.".into());
    }
    if in_place {
        let source = Path::new(&item.source);
        if source.exists() {
            if &fingerprint(source)? != expected {
                return Err(
                    "Original filename is occupied by a different file; undo skipped.".into(),
                );
            }
        } else {
            let temp = source
                .parent()
                .unwrap()
                .join(format!(".mono-undo-{}.part", uuid::Uuid::new_v4()));
            let result = (|| {
                copy_exclusive(output, &temp, &AtomicBool::new(false))?;
                commit(&temp, source)
            })();
            let _ = fs::remove_file(temp);
            result?;
        }
    }
    fs::remove_file(output).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_formats_collision_unicode_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("café 猫.png");
        image::RgbaImage::from_pixel(64, 32, image::Rgba([40, 90, 120, 180]))
            .save(&src)
            .unwrap();
        let bad = dir.path().join("broken.png");
        fs::write(&bad, b"not an image").unwrap();
        for fmt in ["png", "jpeg", "webp"] {
            let s = Settings {
                format: fmt.into(),
                output_folder: dir.path().join("out").to_string_lossy().into(),
                width: 32,
                ..Default::default()
            };
            fs::create_dir_all(&s.output_folder).unwrap();
            let p = preview(
                vec![src.to_string_lossy().into(), bad.to_string_lossy().into()],
                &s,
            )
            .unwrap();
            image_process(&p[0], &s, &AtomicBool::new(false), &mut |_| {}).unwrap();
            let im = image::open(&p[0].output).unwrap();
            assert_eq!((im.width(), im.height()), (32, 16));
            assert!(image_process(&p[1], &s, &AtomicBool::new(false), &mut |_| {}).is_err());
            let p2 = preview(vec![src.to_string_lossy().into()], &s).unwrap();
            assert_ne!(p[0].output, p2[0].output);
            assert!(src.exists());
        }
    }
    #[test]
    fn cancellation_and_racing_collision() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("a.png");
        image::RgbaImage::new(100, 100).save(&src).unwrap();
        let s = Settings {
            output_folder: d.path().to_string_lossy().into(),
            ..Default::default()
        };
        let p = preview(vec![src.to_string_lossy().into()], &s).unwrap();
        assert!(image_process(&p[0], &s, &AtomicBool::new(true), &mut |_| {}).is_err());
        fs::write(&p[0].output, b"existing").unwrap();
        assert!(image_process(&p[0], &s, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert_eq!(fs::read(&p[0].output).unwrap(), b"existing");
    }
    #[test]
    fn rename_preview_and_undo_guards() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("café.txt");
        fs::write(&src, b"hello").unwrap();
        let s = Settings {
            operation: "rename".into(),
            prefix: "new_".into(),
            numbering: true,
            in_place: true,
            ..Default::default()
        };
        let mut p = preview(vec![src.to_string_lossy().into()], &s).unwrap();
        assert!(p[0].output.ends_with("new_café001.txt"));
        copy_exclusive(&src, Path::new(&p[0].output), &AtomicBool::new(false)).unwrap();
        p[0].hash = Some(fingerprint(Path::new(&p[0].output)).unwrap());
        fs::remove_file(&src).unwrap();
        undo_item(&p[0], true).unwrap();
        assert_eq!(fs::read(&src).unwrap(), b"hello");
        assert!(!valid_name("CON.txt"));
        assert!(!valid_name("../escape.txt"));
    }
}
