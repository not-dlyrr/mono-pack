use super::*;
#[test]
fn journal_replay_after_interrupted_compaction() {
    let d = tempfile::tempdir().unwrap();
    let source = d.path().join("file.txt");
    fs::write(&source, b"abc").unwrap();
    let settings = Settings {
        operation: "rename".into(),
        output_folder: d.path().join("out").to_string_lossy().into(),
        prefix: "renamed_".into(),
        ..Default::default()
    };
    let items = preview(vec![source.to_string_lossy().into()], &settings).unwrap();
    let shared = Shared {
        sequence: AtomicU64::new(0),
        store: Mutex::new(Store {
            revision: 0,
            jobs: vec![Job {
                id: "journal".into(),
                settings,
                items,
                status: "running".into(),
                created: 0,
                undo: false,
            }],
            presets: vec![],
        }),
        cancel: Mutex::new(HashMap::new()),
        file: d.path().join("history.json"),
        ffmpeg: PathBuf::new(),
        fault: Mutex::new(None),
    };
    persist(&shared, &shared.store.lock().unwrap()).unwrap();
    let mut item = shared.store.lock().unwrap().jobs[0].items[0].clone();
    item.status = "done".into();
    item.hash = Some(fingerprint(&source).unwrap());
    update_item(&shared, "journal", 0, &item).unwrap();
    let mut restored: Store = serde_json::from_slice(&fs::read(&shared.file).unwrap()).unwrap();
    assert_eq!(
        replay(&mut restored, &shared.file.with_file_name("journal.jsonl")).unwrap(),
        1
    );
    assert_eq!(restored.jobs[0].items[0].status, "done");
    persist(&shared, &shared.store.lock().unwrap()).unwrap();
    let mut restored: Store = serde_json::from_slice(&fs::read(&shared.file).unwrap()).unwrap();
    assert_eq!(restored.revision, 1);
    let old = Record {
        sequence: 1,
        id: "journal".into(),
        index: 0,
        item: Item {
            status: "pending".into(),
            ..item
        },
    };
    fs::write(
        shared.file.with_file_name("journal.jsonl"),
        format!("{}\n", serde_json::to_string(&old).unwrap()),
    )
    .unwrap();
    replay(&mut restored, &shared.file.with_file_name("journal.jsonl")).unwrap();
    assert_eq!(restored.jobs[0].items[0].status, "done");
}
#[test]
fn large_batch_queue_cancellation_remains_responsive() {
    let d = tempfile::tempdir().unwrap();
    let source = d.path().join("input.png");
    image::RgbImage::new(64, 64).save(&source).unwrap();
    let mut paths = vec![];
    for i in 0..1000 {
        let file = d.path().join(format!("image_{i}.png"));
        fs::copy(&source, &file).unwrap();
        paths.push(file.to_string_lossy().into());
    }
    let settings = Settings {
        output_folder: d.path().join("out").to_string_lossy().into(),
        ..Default::default()
    };
    let items = preview(paths, &settings).unwrap();
    assert_eq!(items.len(), 1000);
    let flag = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Shared {
        sequence: AtomicU64::new(0),
        store: Mutex::new(Store {
            revision: 0,
            jobs: vec![Job {
                id: "large".into(),
                settings,
                items,
                status: "queued".into(),
                created: 0,
                undo: false,
            }],
            presets: vec![],
        }),
        cancel: Mutex::new(HashMap::from([("large".into(), flag.clone())])),
        file: d.path().join("history.json"),
        ffmpeg: PathBuf::new(),
        fault: Mutex::new(None),
    });
    let run = shared.clone();
    std::thread::spawn(move || worker(run));
    let start = std::time::Instant::now();
    loop {
        let tick = std::time::Instant::now();
        let job = shared.store.lock().unwrap().jobs[0].clone();
        assert!(tick.elapsed() < Duration::from_millis(250));
        if job.items.iter().filter(|i| i.status == "done").count() >= 5 {
            flag.store(true, Ordering::Relaxed);
        }
        if job.status == "cancelled" {
            assert!(job.items.iter().any(|i| i.status == "cancelled"));
            assert!(job.items.iter().any(|i| i.status == "done"));
            assert!(!job.items.iter().any(|i| i.status == "running"));
            assert!(job.items.iter().all(|i| Path::new(&i.source).exists()));
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(20));
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn real_video_audio_and_active_cancellation() {
    let d = tempfile::tempdir().unwrap();
    let ff = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ffmpeg.exe");
    let source = d.path().join("vidéo 猫.mp4");
    let status = hidden_command(&ff)
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "3",
            "-c:v",
            "mpeg4",
            "-q:v",
            "2",
            "-c:a",
            "aac",
        ])
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());
    for (operation, fmt) in [
        ("video", "mp4"),
        ("video", "webm"),
        ("audio", "mp3"),
        ("audio", "wav"),
        ("audio", "m4a"),
    ] {
        let folder = d.path().join(format!("{}-{}", operation, fmt));
        fs::create_dir(&folder).unwrap();
        let s = Settings {
            operation: operation.into(),
            format: fmt.into(),
            quality: 65,
            width: 320,
            output_folder: folder.to_string_lossy().into(),
            ..Default::default()
        };
        let item = preview(vec![source.to_string_lossy().into()], &s)
            .unwrap()
            .remove(0);
        let mut progress = 0.;
        media_process(&item, &s, &ff, &AtomicBool::new(false), &mut |p| {
            progress = p
        })
        .unwrap();
        assert!(fs::metadata(&item.output).unwrap().len() > 100);
        let check = hidden_command(&ff.with_file_name("ffprobe.exe"))
            .args(["-v", "error", "-show_streams", "-of", "json"])
            .arg(&item.output)
            .output()
            .unwrap();
        assert!(check.status.success());
        let json: serde_json::Value = serde_json::from_slice(&check.stdout).unwrap();
        let streams = json["streams"].as_array().unwrap();
        assert!(streams.iter().any(|v| v["codec_type"]
            == if operation == "audio" {
                "audio"
            } else {
                "video"
            }));
        if operation == "video" {
            assert_eq!(
                streams.iter().find(|v| v["codec_type"] == "video").unwrap()["width"],
                320
            );
        }
        println!(
            "verified {} -> {}: {} bytes, progress {}",
            operation,
            fmt,
            fs::metadata(&item.output).unwrap().len(),
            progress
        );
    }
    let long = d.path().join("long.mp4");
    assert!(hidden_command(&ff)
        .args(["-nostdin", "-v", "error", "-stream_loop", "9", "-i"])
        .arg(&source)
        .args(["-c", "copy"])
        .arg(&long)
        .status()
        .unwrap()
        .success());
    let s = Settings {
        operation: "video".into(),
        format: "webm".into(),
        quality: 90,
        output_folder: d.path().to_string_lossy().into(),
        ..Default::default()
    };
    let item = preview(vec![long.to_string_lossy().into()], &s)
        .unwrap()
        .remove(0);
    let flag = Arc::new(AtomicBool::new(false));
    let set = flag.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        set.store(true, Ordering::Relaxed);
    });
    assert_eq!(
        media_process(&item, &s, &ff, &flag, &mut |_| {}).unwrap_err(),
        "Cancelled"
    );
    assert!(!Path::new(&item.output).exists());
    assert!(source.exists());
    println!("active video cancellation verified: original exists, final output absent");
}
#[test]
fn native_queue_mixed_batch_and_persistence() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("valid.png");
    image::RgbImage::new(32, 32).save(&src).unwrap();
    let bad = d.path().join("corrupt.png");
    fs::write(&bad, b"bad").unwrap();
    let txt = d.path().join("unsupported.txt");
    fs::write(&txt, b"text").unwrap();
    let s = Settings {
        output_folder: d.path().join("out").to_string_lossy().into(),
        ..Default::default()
    };
    let items = preview(
        vec![
            src.to_string_lossy().into(),
            bad.to_string_lossy().into(),
            txt.to_string_lossy().into(),
        ],
        &s,
    )
    .unwrap();
    let shared = Arc::new(Shared {
        sequence: AtomicU64::new(0),
        store: Mutex::new(Store {
            revision: 0,
            jobs: vec![Job {
                id: "test".into(),
                settings: s,
                items,
                status: "queued".into(),
                created: 0,
                undo: false,
            }],
            presets: vec![],
        }),
        cancel: Mutex::new(HashMap::new()),
        file: d.path().join("history.json"),
        ffmpeg: PathBuf::new(),
        fault: Mutex::new(None),
    });
    let run = shared.clone();
    std::thread::spawn(move || worker(run));
    let start = std::time::Instant::now();
    loop {
        let job = shared.store.lock().unwrap().jobs[0].clone();
        if job.status == "completed_with_errors" {
            assert_eq!(job.items[0].status, "done");
            assert_eq!(job.items[1].status, "failed");
            assert_eq!(job.items[2].status, "invalid");
            let bytes = fs::read(&shared.file).unwrap();
            let stored: Store = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(stored.jobs[0].status, job.status);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(src.exists());
}
#[test]
fn interruption_recovery_and_modified_undo() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("file.txt");
    fs::write(&src, b"original").unwrap();
    let s = Settings {
        operation: "rename".into(),
        prefix: "new_".into(),
        in_place: true,
        ..Default::default()
    };
    let mut items = preview(vec![src.to_string_lossy().into()], &s).unwrap();
    items[0].hash = Some(fingerprint(&src).unwrap());
    items[0].status = "running".into();
    fs::copy(&src, &items[0].output).unwrap();
    fs::write(&items[0].temp, b"partial").unwrap();
    let mut store = Store {
        revision: 0,
        jobs: vec![Job {
            id: "recovery".into(),
            settings: s,
            items,
            status: "running".into(),
            created: 0,
            undo: false,
        }],
        presets: vec![],
    };
    recover(&mut store);
    let item = &store.jobs[0].items[0];
    assert_eq!(store.jobs[0].status, "interrupted");
    assert_eq!(item.status, "done");
    assert!(!Path::new(&item.temp).exists());
    fs::write(&item.output, b"edited").unwrap();
    assert!(undo_item(item, true).unwrap_err().contains("changed"));
    assert_eq!(fs::read(&item.output).unwrap(), b"edited");
    fs::write(&item.output, b"original").unwrap();
    undo_item(item, true).unwrap();
    assert_eq!(fs::read(&src).unwrap(), b"original");
}
