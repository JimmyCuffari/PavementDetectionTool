#!/usr/bin/env python3
"""
Pavement Dataset Tool — Local Training Server
Download via the web UI, then run:  python trainer_server.py [--port 7860]

On first run the trainertool:// URL protocol is registered with the OS so
the web app can launch this server automatically in future sessions.
"""
import os, sys, json, re, threading, tempfile, shutil, socket, platform, csv
import subprocess, importlib, time

# Prevent duplicate OpenMP runtime error on Windows (common with PyTorch + OpenCV/numpy)
os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')
from pathlib import Path

# ── Self-install missing packages ─────────────────────────────────────────────
_PACKAGES = ['flask', 'flask_cors', 'requests']
for _pkg in _PACKAGES:
    try:
        importlib.import_module(_pkg)
    except ImportError:
        print(f'Installing {_pkg}...')
        subprocess.check_call([sys.executable, '-m', 'pip', 'install',
                               _pkg.replace('_', '-')], stdout=subprocess.DEVNULL)

from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

@app.errorhandler(Exception)
def handle_exception(e):
    import traceback
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify({'error': str(e)}), e.code
    return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 500

SERVER_PATH = os.path.abspath(__file__)
_CACHE_DIR  = os.path.expanduser('~/pavement_datasets')

# ── URL protocol registration ─────────────────────────────────────────────────
_protocol_registered = False

def _register_protocol():
    global _protocol_registered
    cmd = f'"{sys.executable}" "{SERVER_PATH}"'
    try:
        if platform.system() == 'Windows':
            import winreg
            base = r'Software\Classes\trainertool'
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as k:
                winreg.SetValueEx(k, '', 0, winreg.REG_SZ, 'URL:Pavement Trainer Tool')
                winreg.SetValueEx(k, 'URL Protocol', 0, winreg.REG_SZ, '')
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r'\shell\open\command') as k:
                winreg.SetValueEx(k, '', 0, winreg.REG_SZ, f'{cmd} "%1"')
            _protocol_registered = True
            print('trainertool:// protocol registered (Windows Registry)')

        elif platform.system() == 'Darwin':
            app_dir = Path.home() / 'Applications' / 'PavementTrainer.app'
            macos   = app_dir / 'Contents' / 'MacOS'
            macos.mkdir(parents=True, exist_ok=True)
            (app_dir / 'Contents' / 'Info.plist').write_text(
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
                ' "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
                '<plist version="1.0"><dict>'
                '<key>CFBundleIdentifier</key><string>com.pavementtool.trainer</string>'
                '<key>CFBundleName</key><string>PavementTrainer</string>'
                '<key>CFBundleExecutable</key><string>PavementTrainer</string>'
                '<key>CFBundleURLTypes</key><array><dict>'
                '<key>CFBundleURLSchemes</key>'
                '<array><string>trainertool</string></array>'
                '</dict></array>'
                '</dict></plist>'
            )
            launcher = macos / 'PavementTrainer'
            launcher.write_text('#!/bin/bash\n' + cmd + ' "$@"\n')
            os.chmod(launcher, 0o755)
            lsr_candidates = [
                '/System/Library/Frameworks/CoreServices.framework/Versions/A/'
                'Frameworks/LaunchServices.framework/Versions/A/Support/lsregister',
            ]
            for lsr in lsr_candidates:
                if os.path.exists(lsr):
                    subprocess.run([lsr, '-f', str(app_dir)], capture_output=True, check=False)
                    break
            _protocol_registered = True
            print('trainertool:// app bundle created at ~/Applications/PavementTrainer.app')
        else:
            print(f'Protocol registration not supported on {platform.system()}')
    except Exception as exc:
        print(f'Protocol registration failed (non-fatal): {exc}')

# ── Training job state ────────────────────────────────────────────────────────
_job = {'state': 'idle', 'epoch': 0, 'total': 0, 'batch': 0, 'total_batches': 0,
        'log': [], 'metrics': {}, 'metrics_history': []}
_stop_event  = threading.Event()
_pause_flag  = threading.Event()  # set = paused

# ── Test job state ─────────────────────────────────────────────────────────────
_test_job  = {'state': 'idle', 'log': [], 'metrics': {}, 'class_metrics': {}, 'class_metrics_seg': {}, 'images': {}}
_test_stop = threading.Event()

# ── Threshold-optimization job state ─────────────────────────────────────────────
_thresh_job  = {'state': 'idle', 'log': [], 'box': None, 'seg': None, 'images': {}}
_thresh_stop = threading.Event()

# ── Upload-run job state ─────────────────────────────────────────────────────────
_upload_job = {'state': 'idle', 'log': [], 'error': ''}

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.route('/ping')
def ping():
    base_models_dir = os.path.join(os.path.dirname(SERVER_PATH), 'base_models')
    return jsonify({
        'status': 'ok',
        'protocol_registered': _protocol_registered,
        'server_path': SERVER_PATH,
        'base_models_dir': base_models_dir,
        'python_exe': sys.executable,
        'python_version': sys.version.split()[0],
    })

def _run_in_subprocess(script, timeout=60):
    """Run a Python snippet in a child process; return (stdout, stderr, returncode).
    Isolates fatal DLL crashes so the server process stays alive."""
    proc = subprocess.run(
        [sys.executable, '-c', script],
        capture_output=True, text=True, timeout=timeout,
    )
    return proc.stdout.strip(), proc.stderr.strip(), proc.returncode

@app.route('/device')
def device():
    script = (
        'import torch, json; '
        'cuda=torch.cuda.is_available(); '
        'name=torch.cuda.get_device_name(0) if cuda else ""; '
        'ver=(torch.version.cuda or "") if cuda else ""; '
        'built=torch.version.cuda or ""; '
        'print(json.dumps({"device":name,"cuda":cuda,"cuda_version":ver,"built_for":built}))'
    )
    info = {'device': '', 'cuda': False, 'cuda_version': '', 'note': ''}
    try:
        out, err, rc = _run_in_subprocess(script)
        if rc == 0 and out:
            info.update(json.loads(out))
        else:
            info['note'] = (err or 'torch import failed')[:200]
    except subprocess.TimeoutExpired:
        info['note'] = 'timeout — torch import took too long'
    except Exception as e:
        info['note'] = str(e)[:200]

    # When torch CUDA is unavailable, explain why and get GPU name from driver
    if not info['cuda']:
        built = info.get('built_for', '')
        if built:
            info['note'] = (
                f'torch was built for CUDA {built} but the CUDA runtime is not available '
                f'(driver/DLL mismatch). Reinstall PyTorch for your actual CUDA version.'
            )
        else:
            info['note'] = (
                'CPU-only PyTorch is installed. '
                'Use the GPU Setup section to install the CUDA version for GPU training.'
            )
        # Fall back to nvidia-smi for physical GPU name
        try:
            smi_paths = ['nvidia-smi',
                         r'C:\Windows\System32\nvidia-smi.exe',
                         r'C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe']
            for smi in smi_paths:
                r = subprocess.run(
                    [smi, '--query-gpu=name', '--format=csv,noheader,nounits'],
                    capture_output=True, text=True, timeout=10,
                )
                if r.returncode == 0 and r.stdout.strip():
                    info['device'] = r.stdout.strip().split('\n')[0].strip()
                    break
        except Exception:
            pass

    if not info['device']:
        info['device'] = 'CPU'

    return jsonify(info)

_MOD_TO_PIP = {
    'flask':       'flask',
    'flask_cors':  'flask-cors',
    'requests':    'requests',
    'torch':       'torch',
    'ultralytics': 'ultralytics',
}

@app.route('/requirements')
def requirements():
    import importlib.metadata as _meta
    checks = [
        ('flask',       'flask'),
        ('flask_cors',  'flask-cors'),
        ('requests',    'requests'),
        ('torch',       'torch (PyTorch)'),
        ('ultralytics', 'ultralytics'),
    ]
    result = []
    for mod, label in checks:
        # Primary: subprocess import (crash-safe for broken DLLs)
        script = (
            f'import importlib; m=importlib.import_module("{mod}"); '
            f'print(getattr(m,"__version__","?"))'
        )
        sub_err = ''
        try:
            out, err, rc = _run_in_subprocess(script)
            if rc == 0:
                result.append({'package': label, 'installed': True, 'version': out or '?'})
                continue
            sub_err = (err or 'non-zero exit')[:120]
        except subprocess.TimeoutExpired:
            sub_err = 'import timed out'
        except Exception as e:
            sub_err = str(e)[:120]

        # Fallback: pip metadata lookup — no import, no crash risk.
        # If pip knows about the package it is installed; the subprocess
        # failure is likely a PATH/DLL env difference, not a missing package.
        pip_name = _MOD_TO_PIP.get(mod, mod.replace('_', '-'))
        try:
            ver = _meta.version(pip_name)
            result.append({'package': label, 'installed': True, 'version': ver,
                            'note': f'subprocess check failed ({sub_err})'})
        except _meta.PackageNotFoundError:
            result.append({'package': label, 'installed': False, 'version': sub_err})
    return jsonify(result)

@app.route('/train', methods=['POST'])
def train():
    global _job, _stop_event
    if _job['state'] == 'running':
        return jsonify({'error': 'Training already in progress'}), 409
    data   = request.json or {}
    config = data.get('config', {})
    _job   = {
        'state': 'running',
        'epoch': 0,
        'total': int(config.get('epochs', 100)),
        'batch': 0,
        'total_batches': 0,
        'log':   [],
        'metrics': {},
        'metrics_history': [],
        'drive_token': data.get('drive_token', ''),
        'run_dir':    '',
        'run_name':   '',
        'base_model': '',
        'task':       '',
    }
    _stop_event.clear()
    _pause_flag.clear()
    threading.Thread(
        target=_run_training,
        args=(config, data.get('drive_token', ''), data.get('models_folder_id', '')),
        daemon=True,
    ).start()
    return jsonify({'status': 'started'})

@app.route('/status')
def status():
    return jsonify(_job)

@app.route('/refresh-token', methods=['POST'])
def refresh_drive_token():
    data = request.json or {}
    new_token = data.get('drive_token', '')
    if new_token and _job.get('state') in ('running', 'paused'):
        _job['drive_token'] = new_token
    return jsonify({'ok': True})

@app.route('/post-metrics')
def post_metrics():
    import base64
    run_dir  = _job.get('run_dir', '')
    history  = _job.get('metrics_history', [])
    last     = history[-1] if history else {}

    images = {}
    if run_dir and os.path.isdir(run_dir):
        IMAGE_ORDER = [
            'confusion_matrix_normalized.png',
            'confusion_matrix.png',
            'results.png',
            'PR_curve.png',
            'F1_curve.png',
            'P_curve.png',
            'R_curve.png',
            'labels.jpg',
            'labels_correlogram.jpg',
        ]
        for name in IMAGE_ORDER:
            path = os.path.join(run_dir, name)
            if os.path.isfile(path):
                ext  = name.rsplit('.', 1)[-1].lower()
                mime = 'image/jpeg' if ext in ('jpg', 'jpeg') else 'image/png'
                with open(path, 'rb') as f:
                    images[name] = f'data:{mime};base64,{base64.b64encode(f.read()).decode()}'

    return jsonify({
        'ready':             bool(run_dir),
        'run_dir':           run_dir,
        'run_name':          _job.get('run_name', ''),
        'base_model':        _job.get('base_model', ''),
        'task':              _job.get('task', ''),
        'epochs_completed':  _job.get('epoch', 0),
        'summary':           _compute_summary(history),
        'class_metrics':     last.get('class_metrics', {}),
        'class_metrics_seg': last.get('class_metrics_seg', {}),
        'images':            images,
    })

@app.route('/test', methods=['POST'])
def start_test():
    global _test_job, _test_stop
    if _test_job.get('state') == 'running':
        return jsonify({'error': 'Test already in progress'}), 409
    data = request.json or {}
    _test_job = {'state': 'running', 'log': [], 'metrics': {}, 'class_metrics': {}, 'class_metrics_seg': {}, 'images': {}}
    _test_stop.clear()
    threading.Thread(target=_run_test, args=(data,), daemon=True).start()
    return jsonify({'status': 'started'})

@app.route('/test-status')
def test_status():
    return jsonify(_test_job)

@app.route('/test-stop', methods=['POST'])
def stop_test():
    _test_stop.set()
    if _test_job.get('state') == 'running':
        _test_job['state'] = 'stopped'
    return jsonify({'ok': True})

@app.route('/optimize-threshold', methods=['POST'])
def start_optimize_threshold():
    global _thresh_job, _thresh_stop
    if _thresh_job.get('state') == 'running':
        return jsonify({'error': 'Threshold optimization already in progress'}), 409
    data = request.json or {}
    _thresh_job = {'state': 'running', 'log': [], 'box': None, 'seg': None, 'images': {}}
    _thresh_stop.clear()
    threading.Thread(target=_run_optimize_threshold, args=(data,), daemon=True).start()
    return jsonify({'status': 'started'})

@app.route('/optimize-threshold-status')
def optimize_threshold_status():
    return jsonify(_thresh_job)

@app.route('/optimize-threshold-stop', methods=['POST'])
def stop_optimize_threshold():
    _thresh_stop.set()
    if _thresh_job.get('state') == 'running':
        _thresh_job['state'] = 'stopped'
    return jsonify({'ok': True})

@app.route('/upload-run', methods=['POST'])
def upload_run():
    global _upload_job
    if _upload_job.get('state') == 'running':
        return jsonify({'error': 'An upload is already in progress'}), 409
    _upload_job = {'state': 'running', 'log': [], 'error': ''}
    threading.Thread(target=_run_upload_from_folder, args=(request.json or {},), daemon=True).start()
    return jsonify({'status': 'started'})

@app.route('/upload-run-status')
def upload_run_status():
    return jsonify(_upload_job)

@app.route('/stop', methods=['POST'])
def stop_training():
    _pause_flag.clear()   # unblock any pause wait so the stop is seen immediately
    _stop_event.set()
    if _job['state'] in ('running', 'paused'):
        _job['state'] = 'stopped'
    return jsonify({'status': 'stopping'})

@app.route('/pause', methods=['POST'])
def pause_training():
    if _job['state'] == 'running':
        _pause_flag.set()
        _job['state'] = 'paused'
        _log('Training paused — will hold after current epoch finishes')
    return jsonify({'status': _job['state']})

@app.route('/resume', methods=['POST'])
def resume_training():
    if _job['state'] == 'paused':
        _pause_flag.clear()
        _job['state'] = 'running'
        _log('Training resumed')
    return jsonify({'status': _job['state']})

@app.route('/shutdown', methods=['POST'])
def shutdown():
    def _stop():
        time.sleep(0.3)
        os._exit(0)
    threading.Thread(target=_stop, daemon=True).start()
    return jsonify({'status': 'shutting down'})

_install_job = {'state': 'idle', 'log': [], 'returncode': None}

@app.route('/install-torch', methods=['POST'])
def install_torch():
    global _install_job
    if _install_job['state'] == 'running':
        return jsonify({'error': 'Installation already in progress'}), 409
    data = request.json or {}
    args = data.get('args', '').strip()
    if not args:
        return jsonify({'error': 'No install arguments provided'}), 400
    _install_job = {'state': 'running', 'log': [], 'returncode': None}
    def _run():
        global _install_job
        try:
            proc = subprocess.Popen(
                [sys.executable, '-m', 'pip', 'install'] + args.split(),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            )
            for line in proc.stdout:
                _install_job['log'].append(line.rstrip())
            proc.wait()
            _install_job['returncode'] = proc.returncode
            _install_job['state'] = 'done' if proc.returncode == 0 else 'error'
        except Exception as e:
            _install_job['log'].append(f'Error: {e}')
            _install_job['state'] = 'error'
    threading.Thread(target=_run, daemon=True).start()
    return jsonify({'status': 'started'})

@app.route('/install-status')
def install_status():
    return jsonify(_install_job)

@app.route('/cache-status')
def cache_status():
    folder_id = request.args.get('folder_id', '')
    if not folder_id:
        return jsonify({'error': 'folder_id required'}), 400
    cached = _is_cached(folder_id)
    result = {'cached': cached, 'path': _cache_path(folder_id)}
    if cached:
        try:
            result.update(json.loads(Path(_cache_sentinel(folder_id)).read_text()))
        except Exception:
            pass
        try:
            result['size'] = sum(
                f.stat().st_size for f in Path(_cache_path(folder_id)).rglob('*') if f.is_file()
            )
        except Exception:
            pass
    return jsonify(result)

_pdl_job = {'state': 'idle', 'log': [], 'folder_id': '', 'file_count': 0}

@app.route('/pre-download', methods=['POST'])
def pre_download():
    global _pdl_job
    if _pdl_job['state'] == 'running':
        return jsonify({'error': 'Pre-download already in progress'}), 409
    data      = request.json or {}
    folder_id = data.get('folder_id', '')
    token     = data.get('drive_token', '')
    if not folder_id or not token:
        return jsonify({'error': 'folder_id and drive_token required'}), 400
    _pdl_job = {'state': 'running', 'log': [], 'folder_id': folder_id, 'file_count': 0}
    def _run():
        global _pdl_job
        path = _cache_path(folder_id)
        try:
            os.makedirs(path, exist_ok=True)
            _pdl_job['log'].append('Scanning Drive folder...')
            count = _dl_folder(token, folder_id, path)
            _pdl_job['file_count'] = count
            Path(_cache_sentinel(folder_id)).write_text(json.dumps({
                'folder_id': folder_id, 'file_count': count,
                'cached_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }))
            _pdl_job['log'].append(f'Cached {count} files to {path}')
            _pdl_job['state'] = 'done'
        except Exception as exc:
            shutil.rmtree(path, ignore_errors=True)
            _pdl_job['log'].append(f'Error: {exc}')
            _pdl_job['state'] = 'error'
    threading.Thread(target=_run, daemon=True).start()
    return jsonify({'status': 'started'})

@app.route('/pre-download-status')
def pre_download_status():
    return jsonify(_pdl_job)

@app.route('/find-yaml')
def find_yaml():
    dir_path = request.args.get('dir', '').strip()
    if not dir_path or not os.path.isdir(dir_path):
        return jsonify({'yaml_path': None, 'error': 'Directory not found'})
    yamls = list(Path(dir_path).rglob('data.yaml')) or list(Path(dir_path).rglob('*.yaml'))
    return jsonify({'yaml_path': str(yamls[0]) if yamls else None})

@app.route('/browse-folder')
def browse_folder():
    try:
        if platform.system() == 'Windows':
            ps = ('Add-Type -AssemblyName System.Windows.Forms; '
                  '$d = New-Object System.Windows.Forms.FolderBrowserDialog; '
                  '$d.ShowDialog() | Out-Null; Write-Output $d.SelectedPath')
            r = subprocess.run(['powershell', '-Command', ps],
                               capture_output=True, text=True, timeout=60)
            path = r.stdout.strip()
        else:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.wm_attributes('-topmost', 1)
            path = filedialog.askdirectory(); root.destroy()
        return jsonify({'path': path or None})
    except Exception as e:
        return jsonify({'path': None, 'error': str(e)})

@app.route('/browse-file')
def browse_file():
    ext = request.args.get('ext', '*')
    try:
        if platform.system() == 'Windows':
            filt = (f'Files (*.{ext})|*.{ext}|All Files (*.*)|*.*'
                    if ext != '*' else 'All Files (*.*)|*.*')
            ps = ('Add-Type -AssemblyName System.Windows.Forms; '
                  f'$d = New-Object System.Windows.Forms.OpenFileDialog; '
                  f'$d.Filter = "{filt}"; '
                  '$d.ShowDialog() | Out-Null; Write-Output $d.FileName')
            r = subprocess.run(['powershell', '-Command', ps],
                               capture_output=True, text=True, timeout=60)
            path = r.stdout.strip()
        else:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw(); root.wm_attributes('-topmost', 1)
            fts = [(f'{ext.upper()} files', f'*.{ext}')] if ext != '*' else [('All', '*')]
            path = filedialog.askopenfilename(filetypes=fts); root.destroy()
        return jsonify({'path': path or None})
    except Exception as e:
        return jsonify({'path': None, 'error': str(e)})

@app.route('/gpu-info')
def gpu_info():
    result = {'has_nvidia': False, 'gpu_name': '', 'driver_version': '', 'cuda_driver_version': ''}
    try:
        r = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0 and r.stdout.strip():
            parts = r.stdout.strip().split('\n')[0].split(',')
            result['has_nvidia'] = True
            result['gpu_name']       = parts[0].strip() if parts else ''
            result['driver_version'] = parts[1].strip() if len(parts) > 1 else ''
        r2 = subprocess.run(['nvidia-smi'], capture_output=True, text=True, timeout=10)
        if r2.returncode == 0:
            m = re.search(r'CUDA Version:\s*(\d+\.\d+)', r2.stdout)
            if m:
                result['cuda_driver_version'] = m.group(1)
    except FileNotFoundError:
        pass  # nvidia-smi not found — no NVIDIA GPU or drivers not installed
    except Exception as e:
        result['error'] = str(e)[:200]
    return jsonify(result)

@app.route('/preprocess-preview', methods=['POST'])
def preprocess_preview():
    import base64
    file = request.files.get('image')
    pp_raw = request.form.get('pp', '{}')
    if not file:
        return jsonify({'error': 'No image provided'}), 400
    pp = json.loads(pp_raw)
    try:
        import cv2
        import numpy as np
        data = np.frombuffer(file.read(), np.uint8)
        img = cv2.imdecode(data, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({'error': 'Could not decode image'}), 400
        _, orig_buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        orig_b64 = base64.b64encode(orig_buf).decode()
        processed = _apply_preprocessing(img.copy(), pp)
        _, proc_buf = cv2.imencode('.jpg', processed, [cv2.IMWRITE_JPEG_QUALITY, 85])
        proc_b64 = base64.b64encode(proc_buf).decode()
        return jsonify({'original': orig_b64, 'processed': proc_b64})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── Training helpers ──────────────────────────────────────────────────────────

def _log(msg):
    _job['log'].append(msg)
    print(msg)

def _dl_folder(token, folder_id, dest, workers=8):
    """Download a Drive folder recursively with parallel file downloads."""
    import requests as req
    from concurrent.futures import ThreadPoolExecutor, as_completed
    hdr = {'Authorization': f'Bearer {token}'}

    def _collect(fid, base_dest, out):
        os.makedirs(base_dest, exist_ok=True)
        r = req.get(
            'https://www.googleapis.com/drive/v3/files',
            headers=hdr,
            params={'q': f"'{fid}' in parents and trashed=false",
                    'fields': 'files(id,name,mimeType)', 'pageSize': 1000},
        )
        r.raise_for_status()
        for f in r.json().get('files', []):
            target = os.path.join(base_dest, f['name'])
            if f['mimeType'] == 'application/vnd.google-apps.folder':
                _collect(f['id'], target, out)
            else:
                out.append((f['id'], target))

    def _dl_one(file_id, path):
        r = req.get(f'https://www.googleapis.com/drive/v3/files/{file_id}?alt=media',
                    headers=hdr, timeout=120)
        r.raise_for_status()
        with open(path, 'wb') as fp:
            fp.write(r.content)

    files = []
    _collect(folder_id, dest, files)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_dl_one, fid, path): path for fid, path in files}
        for fut in as_completed(futures):
            fut.result()
    return len(files)

def _cache_path(folder_id):
    return os.path.join(_CACHE_DIR, folder_id)

def _cache_sentinel(folder_id):
    return os.path.join(_cache_path(folder_id), '.pavement_cache')

def _is_cached(folder_id):
    return os.path.isfile(_cache_sentinel(folder_id))

def _upload_file(token, folder_id, local_path, name):
    import requests as req
    with open(local_path, 'rb') as f:
        data = f.read()
    meta = json.dumps({'name': name, 'parents': [folder_id]})
    r = req.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        headers={'Authorization': f'Bearer {token}'},
        files={
            'metadata': (None, meta, 'application/json'),
            'file':     (name, data, 'application/octet-stream'),
        },
    )
    r.raise_for_status()

def _upload_bytes(token, folder_id, name, mime, content_bytes):
    import requests as req
    meta = json.dumps({'name': name, 'parents': [folder_id]})
    r = req.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        headers={'Authorization': f'Bearer {token}'},
        files={'metadata': (None, meta, 'application/json'), 'file': (name, content_bytes, mime)},
    )
    r.raise_for_status()

def _patch_yaml(yaml_path, dataset_dir):
    content = Path(yaml_path).read_text(encoding='utf-8')
    abs_dir = str(Path(dataset_dir).resolve()).replace('\\', '/')
    content = re.sub(r'^path:.*$', f'path: {abs_dir}', content, flags=re.MULTILINE)
    if not re.search(r'^path:', content, re.MULTILINE):
        content = f'path: {abs_dir}\n' + content
    Path(yaml_path).write_text(content, encoding='utf-8')

def _apply_preprocessing(img_bgr, pp):
    """Apply a preprocessing pipeline to a BGR image and return the result."""
    import cv2, numpy as np
    img = img_bgr.copy()

    if pp.get('grayscale'):
        img = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)

    b = int(pp.get('brightness', 0))
    c = int(pp.get('contrast', 0))
    if b != 0 or c != 0:
        img = cv2.convertScaleAbs(img, alpha=1 + c / 100.0, beta=b)

    sat = int(pp.get('saturation', 0))
    if sat != 0:
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.int16)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] + sat, 0, 255)
        img = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    gamma = float(pp.get('gamma', 1.0))
    if abs(gamma - 1.0) > 0.001:
        lut = np.array([min(255, int((i / 255.0) ** (1.0 / gamma) * 255)) for i in range(256)], dtype=np.uint8)
        img = cv2.LUT(img, lut)

    gk = int(pp.get('gaussian_kernel', 1))
    if gk > 1:
        if gk % 2 == 0:
            gk += 1
        img = cv2.GaussianBlur(img, (gk, gk), 0)

    mk = int(pp.get('median_kernel', 1))
    if mk > 1:
        if mk % 2 == 0:
            mk += 1
        img = cv2.medianBlur(img, mk)

    sharpen = float(pp.get('sharpen', 0))
    if sharpen > 0:
        kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
        sharpened = cv2.filter2D(img, -1, kernel)
        img = cv2.addWeighted(img, 1.0, sharpened, sharpen, 0)
        img = np.clip(img, 0, 255).astype(np.uint8)

    clahe_clip = float(pp.get('clahe_clip', 0))
    if clahe_clip > 0:
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
        lab[:, :, 0] = clahe.apply(lab[:, :, 0])
        img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    if pp.get('canny_enable'):
        lo = int(pp.get('canny_low', 50))
        hi = int(pp.get('canny_high', 150))
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, lo, hi)
        img[:, :, 1] = np.clip(img[:, :, 1].astype(np.int16) + edges, 0, 255).astype(np.uint8)

    if pp.get('frangi_enable'):
        try:
            from skimage.filters import frangi
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float64) / 255.0
            sc_min = float(pp.get('frangi_scale_min', 1))
            sc_max = float(pp.get('frangi_scale_max', 10))
            result = frangi(gray, sigmas=range(int(sc_min), int(sc_max) + 1, 2), black_ridges=False)
            result = (result / (result.max() + 1e-9) * 255).astype(np.uint8)
            img[:, :, 0] = np.clip(img[:, :, 0].astype(np.int16) + result, 0, 255).astype(np.uint8)
        except ImportError:
            pass

    return img

def _preprocess_dataset(src_yaml, pp, out_root):
    """Copy a YOLO dataset through the preprocessing pipeline into out_root."""
    import cv2
    yaml_path = Path(src_yaml)
    ds_dir    = yaml_path.parent
    out_path  = Path(out_root)
    out_path.mkdir(parents=True, exist_ok=True)

    content = yaml_path.read_text(encoding='utf-8')
    for split in ('train', 'val', 'test'):
        m = re.search(rf'^{split}:\s*(.+)$', content, re.MULTILINE)
        if not m:
            continue
        rel = m.group(1).strip()
        src_img_dir = (ds_dir / rel).resolve()
        if not src_img_dir.exists():
            continue
        dst_img_dir = out_path / split / 'images'
        dst_lbl_dir = out_path / split / 'labels'
        dst_img_dir.mkdir(parents=True, exist_ok=True)
        dst_lbl_dir.mkdir(parents=True, exist_ok=True)

        for img_file in src_img_dir.iterdir():
            if img_file.suffix.lower() not in ('.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'):
                continue
            img = cv2.imread(str(img_file))
            if img is not None:
                processed = _apply_preprocessing(img, pp)
                cv2.imwrite(str(dst_img_dir / img_file.name), processed)

        # Copy labels unchanged
        src_lbl_dir = src_img_dir.parent.parent / 'labels' / src_img_dir.name
        if not src_lbl_dir.exists():
            src_lbl_dir = src_img_dir.parent / 'labels'
        if src_lbl_dir.exists():
            for lbl_file in src_lbl_dir.iterdir():
                shutil.copy2(str(lbl_file), str(dst_lbl_dir / lbl_file.name))

    new_content = re.sub(r'^path:.*$', f'path: {str(out_path).replace(chr(92), "/")}', content, flags=re.MULTILINE)
    if not re.search(r'^path:', new_content, re.MULTILINE):
        new_content = f'path: {str(out_path).replace(chr(92), "/")}\n' + new_content
    for split in ('train', 'val', 'test'):
        new_content = re.sub(
            rf'^({split}:\s*).*$',
            lambda m2, s=split: f'{s}: {s}/images',
            new_content, flags=re.MULTILINE,
        )
    new_yaml = out_path / 'data.yaml'
    new_yaml.write_text(new_content, encoding='utf-8')
    return str(new_yaml)

# Release tags for each YOLO model family on github.com/ultralytics/assets
_YOLO_RELEASE = {
    'yolo26': 'v8.4.0',
    'yolo11': 'v8.3.0',
    'yolo10': 'v8.2.0',
    'yolov8': 'v8.1.0',
    'yolov5': 'v7.0',
}

def _download_base_model(model_name, base_models_dir):
    """Download model_name.pt from Ultralytics GitHub releases into base_models_dir."""
    import requests as req
    version = next(
        (v for prefix, v in _YOLO_RELEASE.items() if model_name.lower().startswith(prefix)),
        'v8.3.0'
    )
    url  = f'https://github.com/ultralytics/assets/releases/download/{version}/{model_name}.pt'
    dest = os.path.join(base_models_dir, f'{model_name}.pt')
    os.makedirs(base_models_dir, exist_ok=True)
    _log(f'Downloading {model_name}.pt from {url}')
    r = req.get(url, stream=True, timeout=300, allow_redirects=True)
    r.raise_for_status()
    total = int(r.headers.get('content-length', 0))
    done  = 0
    last_pct = -1
    with open(dest, 'wb') as f:
        for chunk in r.iter_content(chunk_size=65536):
            if chunk:
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = int(done / total * 100)
                    if pct // 10 != last_pct // 10:
                        _log(f'  {pct}%  ({done/1024/1024:.1f} / {total/1024/1024:.1f} MB)')
                        last_pct = pct
    _log(f'Saved to {dest}')
    return dest

_RUN_ARTIFACT_FILES = [
    'results.csv', 'results.png',
    'confusion_matrix.png', 'confusion_matrix_normalized.png',
    'F1_curve.png', 'PR_curve.png', 'P_curve.png', 'R_curve.png',
    'BoxF1_curve.png', 'BoxPR_curve.png', 'BoxP_curve.png', 'BoxR_curve.png',
    'MaskF1_curve.png', 'MaskPR_curve.png', 'MaskP_curve.png', 'MaskR_curve.png',
    'labels.jpg', 'labels_correlogram.jpg',
]
_RUN_ARTIFACT_GLOBS = ['train_batch*.jpg', 'val_batch*_labels.jpg', 'val_batch*_pred.jpg']

def _collect_run_artifacts(run_dir):
    paths = [os.path.join(run_dir, n) for n in _RUN_ARTIFACT_FILES]
    paths = [p for p in paths if os.path.isfile(p)]
    for pattern in _RUN_ARTIFACT_GLOBS:
        paths += [str(p) for p in Path(run_dir).glob(pattern)]
    return paths

def _upload_run_artifacts(token, folder_id, run_dir, run_name, log=lambda m: None):
    artifacts = {}
    for path in _collect_run_artifacts(run_dir):
        name = os.path.basename(path)
        upload_name = f'{run_name}__{name}'
        try:
            log(f'Uploading {upload_name}...')
            _upload_file(token, folder_id, path, upload_name)
            artifacts[name] = upload_name
        except Exception as exc:
            log(f'Warning: failed to upload {name}: {exc}')
    return artifacts

def _compute_summary(history):
    if not history: return {}
    pick = lambda k: [m[k] for m in history if m.get(k) is not None]
    m50  = pick('metrics/mAP50(B)')
    m95  = pick('metrics/mAP50-95(B)')
    prec = pick('metrics/precision(B)')
    rec  = pick('metrics/recall(B)')
    m50m = pick('metrics/mAP50(M)')
    m95m = pick('metrics/mAP50-95(M)')
    return {
        'best_map50':         round(max(m50), 4)      if m50  else None,
        'best_map50_95':      round(max(m95), 4)      if m95  else None,
        'final_precision':    round(prec[-1], 4)      if prec else None,
        'final_recall':       round(rec[-1],  4)      if rec  else None,
        'best_map50_epoch':   m50.index(max(m50)) + 1 if m50  else None,
        'best_mask_map50':    round(max(m50m), 4)     if m50m else None,
        'best_mask_map50_95': round(max(m95m), 4)     if m95m else None,
    }

def _run_upload_from_folder(data):
    global _upload_job
    def ulog(msg): _upload_job['log'].append(msg)
    try:
        run_dir   = data.get('run_dir', '').strip()
        run_name  = data.get('run_name', '').strip()
        token     = data.get('drive_token', '')
        folder_id = data.get('models_folder_id', '')

        if not run_dir or not os.path.isdir(run_dir):
            _upload_job.update(state='error', error=f'Run folder not found: {run_dir!r}'); return
        if not token or not folder_id:
            _upload_job.update(state='error', error='Missing Drive token or models folder.'); return
        if not run_name:
            run_name = os.path.basename(os.path.normpath(run_dir))

        best_pts = list(Path(run_dir).rglob('best.pt'))
        if not best_pts:
            _upload_job.update(state='error', error='No best.pt found in that folder.'); return

        history = []
        results_csv = os.path.join(run_dir, 'results.csv')
        if os.path.isfile(results_csv):
            with open(results_csv, newline='') as f:
                for row in csv.DictReader(f):
                    snap = {}
                    for k, v in row.items():
                        if k is None: continue
                        try: snap[k.strip()] = float(v)
                        except (TypeError, ValueError): pass
                    history.append(snap)

        base_model, task = '', ''
        args_yaml = os.path.join(run_dir, 'args.yaml')
        if os.path.isfile(args_yaml):
            try:
                import yaml
                args = yaml.safe_load(Path(args_yaml).read_text()) or {}
                task = args.get('task', '') or ''
                base_model = Path(str(args.get('model', ''))).stem
            except Exception:
                pass

        upload_name = f'{run_name}_best.pt'
        ulog(f'Uploading {upload_name}...')
        _upload_file(token, folder_id, str(best_pts[0]), upload_name)

        artifacts = _upload_run_artifacts(token, folder_id, run_dir, run_name, ulog)

        metrics_payload = {
            'run_name': run_name, 'model_file': upload_name,
            'base_model': base_model, 'task': task,
            'epochs_completed': len(history),
            'trained_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'summary': _compute_summary(history),
            'metrics_history': history,
            'artifacts': artifacts,
        }
        ulog('Uploading metrics JSON...')
        _upload_bytes(token, folder_id, f'{run_name}_metrics.json',
                      'application/json', json.dumps(metrics_payload).encode())
        ulog('Done.')
        _upload_job['state'] = 'done'
    except Exception as exc:
        _upload_job.update(state='error', error=str(exc))

def _run_training(config, token, models_folder_id):
    global _job
    tmp    = tempfile.mkdtemp(prefix='pavement_train_')
    pp_tmp = None
    runs_dir = None
    cache_dir_to_release = None
    try:
        registry_folder_id = config.get('registry_folder_id', '').strip()
        if registry_folder_id:
            local_data_dir  = _cache_path(registry_folder_id)
            local_yaml_path = ''
            if os.path.isdir(local_data_dir):
                shutil.rmtree(local_data_dir, ignore_errors=True)
            _log('Downloading dataset from registry...')
            try:
                count = _dl_folder(token, registry_folder_id, local_data_dir)
                _log(f'Downloaded {count} files to cache.')
            except Exception as dl_err:
                _job['state'] = 'error'
                _log(f'Error: Failed to download dataset from registry: {dl_err}')
                shutil.rmtree(local_data_dir, ignore_errors=True)
                return
            cache_dir_to_release = local_data_dir
            runs_dir = os.path.join(_CACHE_DIR, '_runs')
            os.makedirs(runs_dir, exist_ok=True)
        else:
            local_data_dir  = config.get('local_data_dir', '').strip()
            local_yaml_path = config.get('local_yaml_path', '').strip()

            if not local_data_dir or not os.path.isdir(local_data_dir):
                _job['state'] = 'error'
                _log(f'Error: Dataset folder not found: {local_data_dir!r}')
                return

            runs_dir = os.path.join(local_data_dir, 'runs')
            os.makedirs(runs_dir, exist_ok=True)

        if local_yaml_path and os.path.isfile(local_yaml_path):
            yaml_path = local_yaml_path
        else:
            yamls = list(Path(local_data_dir).rglob('data.yaml')) or list(Path(local_data_dir).rglob('*.yaml'))
            if not yamls:
                _job['state'] = 'error'
                _log('Error: No .yaml file found in the dataset folder.')
                return
            yaml_path = str(yamls[0])

        _patch_yaml(yaml_path, local_data_dir)
        _log(f'Dataset config: {yaml_path}')

        if _stop_event.is_set():
            _job['state'] = 'stopped'
            return

        from ultralytics import YOLO
        base_model = config.get('base_model', 'yolo11n')
        task       = config.get('task', 'detect')
        run_name   = config.get('run_name', f'run_{int(time.time())}')
        epochs     = int(config.get('epochs', 100))
        _job['run_name']   = run_name
        _job['base_model'] = base_model
        _job['task']       = task

        # Device mapping: null/'auto' → None (YOLO auto-selects), 'cpu' → 'cpu', 0 → 0
        raw_device = config.get('device', None)
        device = None if raw_device in (None, 'auto') else raw_device

        # Preprocessing: apply pipeline to dataset if enabled
        pp = config.get('pp', {})
        pp_tmp = None
        if pp.get('enabled'):
            _log('Preprocessing dataset...')
            pp_tmp = tempfile.mkdtemp(prefix='pavement_pp_')
            try:
                yaml_path = _preprocess_dataset(yaml_path, pp, pp_tmp)
                _log(f'Preprocessed dataset ready: {pp_tmp}')
            except Exception as pp_err:
                _log(f'Preprocessing failed ({pp_err}) — using original dataset')
                shutil.rmtree(pp_tmp, ignore_errors=True)
                pp_tmp = None

        # Segmentation task requires the -seg model variant
        if task == 'segment' and not base_model.endswith('-seg'):
            base_model = f'{base_model}-seg'
            _log(f'Segmentation task: switching to {base_model}')

        base_models_dir = os.path.join(os.path.dirname(SERVER_PATH), 'base_models')
        os.makedirs(base_models_dir, exist_ok=True)

        # Point Ultralytics weights cache to our base_models dir so AMP checks
        # don't try to write to a restricted current working directory
        try:
            from ultralytics.utils import SETTINGS
            SETTINGS['weights_dir'] = base_models_dir
        except Exception:
            pass
        # Also set CWD to base_models_dir so any relative-path downloads land there
        os.chdir(base_models_dir)

        # Pre-download the nano model used by YOLO's internal AMP check
        # (Ultralytics downloads yolo26n.pt regardless of the actual training model)
        _amp_nano = 'yolo26n'
        _amp_pt   = os.path.join(base_models_dir, f'{_amp_nano}.pt')
        if not os.path.isfile(_amp_pt):
            _log(f'Pre-downloading {_amp_nano}.pt for YOLO AMP check...')
            try:
                _download_base_model(_amp_nano, base_models_dir)
            except Exception as amp_err:
                _log(f'Warning: Could not pre-download AMP model ({amp_err}) — YOLO will attempt it directly')

        local_model_path = config.get('local_model_path', '').strip()
        if local_model_path and os.path.isfile(local_model_path):
            model_pt = local_model_path
            _log(f'Resuming training from local model: {model_pt}')
        else:
            model_pt = os.path.join(base_models_dir, f'{base_model}.pt')
            if not os.path.isfile(model_pt):
                _log(f'Base model not cached — downloading from Ultralytics...')
                try:
                    model_pt = _download_base_model(base_model, base_models_dir)
                except Exception as dl_err:
                    _job['state'] = 'error'
                    _log(f'Error: Could not download base model: {dl_err}')
                    _log(f'Manually place {base_model}.pt in: {base_models_dir}')
                    return
        _log(f'Loading base model: {model_pt}')
        model = YOLO(model_pt)

        def on_train_epoch_start(trainer):
            _job['batch'] = 0
            try: _job['total_batches'] = len(trainer.train_loader)
            except Exception: pass

        def on_train_batch_end(trainer):
            _job['batch'] = _job.get('batch', 0) + 1
            if not _job.get('total_batches'):
                try: _job['total_batches'] = len(trainer.train_loader)
                except Exception: pass

        def on_epoch_end(trainer):
            ep = trainer.epoch + 1
            _job['epoch'] = ep
            _job['batch'] = _job.get('total_batches', 0)  # mark epoch complete
            try:
                loss_val = float(trainer.loss)
            except Exception:
                loss_val = 0.0
            _log(f'Epoch {ep}/{epochs}  loss={loss_val:.4f}')
            if _stop_event.is_set():
                try:
                    trainer.stop = True
                except Exception:
                    pass

        def on_fit_epoch_end(trainer):
            snapshot = {}
            try:
                for k, v in (trainer.metrics or {}).items():
                    try: snapshot[k] = round(float(v), 6)
                    except Exception: pass
            except Exception:
                pass
            # Capture train losses — use trainer's own label mapping so order is correct
            # for any task (detect: box,cls,dfl; segment: box,seg,cls,dfl; pose: etc.)
            try:
                li = trainer.loss_items
                if li is not None:
                    try:
                        labeled = trainer.label_loss_items(loss_items=li, prefix='train')
                        for k, v in labeled.items():
                            try: snapshot[k] = round(float(v), 6)
                            except Exception: pass
                    except Exception:
                        # fallback: detect order
                        for i, k in enumerate(['train/box_loss','train/cls_loss','train/dfl_loss']):
                            try: snapshot[k] = round(float(li[i]), 6)
                            except Exception: pass
            except Exception:
                pass
            # Capture learning rates
            try:
                for i, pg in enumerate(trainer.optimizer.param_groups):
                    snapshot[f'lr/pg{i}'] = round(float(pg['lr']), 8)
            except Exception:
                pass
            # Capture per-class validation metrics (bbox and segmentation separately)
            try:
                validator = trainer.validator
                if validator is not None:
                    vm  = getattr(validator, 'metrics', None)
                    nms = getattr(validator, 'names', {}) or {}
                    if vm is not None:
                        def _get_cls_metrics(metric_obj):
                            result = {}
                            ap_ci = getattr(metric_obj, 'ap_class_index', None)
                            if ap_ci is not None and hasattr(metric_obj, 'class_result'):
                                for i in range(len(ap_ci)):
                                    try:
                                        res  = metric_obj.class_result(i)
                                        name = nms.get(int(ap_ci[i]), str(ap_ci[i]))
                                        result[name] = {
                                            'p':    round(float(res[0]), 4),
                                            'r':    round(float(res[1]), 4),
                                            'ap50': round(float(res[2]), 4),
                                            'ap':   round(float(res[3]), 4),
                                        }
                                    except Exception:
                                        pass
                            return result
                        box_obj = getattr(vm, 'box', None) or vm
                        seg_obj = getattr(vm, 'seg', None)
                        bbox_cls = _get_cls_metrics(box_obj)
                        if bbox_cls:
                            snapshot['class_metrics'] = bbox_cls
                        if seg_obj:
                            seg_cls = _get_cls_metrics(seg_obj)
                            if seg_cls:
                                snapshot['class_metrics_seg'] = seg_cls
            except Exception:
                pass
            _job['metrics_history'].append(snapshot)

            # Pause: hold here (between epochs) until resumed or stopped
            if _pause_flag.is_set():
                while _pause_flag.is_set() and not _stop_event.is_set():
                    time.sleep(0.3)
                if _stop_event.is_set():
                    try: trainer.stop = True
                    except Exception: pass

        model.add_callback('on_train_epoch_start', on_train_epoch_start)
        model.add_callback('on_train_batch_end',   on_train_batch_end)
        model.add_callback('on_train_epoch_end',   on_epoch_end)
        model.add_callback('on_fit_epoch_end',     on_fit_epoch_end)

        imgsz   = int(config.get('imgsz', 640))
        batch   = int(config.get('batch', 16))
        _log(f'Training: {base_model} | task={task} | epochs={epochs} | imgsz={imgsz} | batch={batch}')

        train_kwargs = dict(
            data=yaml_path, task=task, name=run_name,
            epochs=epochs, imgsz=imgsz, batch=batch,
            optimizer=config.get('optimizer', 'auto'),
            lr0=float(config.get('lr0', 0.01)),
            lrf=float(config.get('lrf', 0.01)),
            warmup_epochs=float(config.get('warmup_epochs', 3)),
            patience=int(config.get('patience', 50)),
            momentum=float(config.get('momentum', 0.937)),
            weight_decay=float(config.get('weight_decay', 0.0005)),
            warmup_momentum=float(config.get('warmup_momentum', 0.8)),
            warmup_bias_lr=float(config.get('warmup_bias_lr', 0.1)),
            nbs=int(config.get('nbs', 64)),
            dropout=float(config.get('dropout', 0)),
            label_smoothing=float(config.get('label_smoothing', 0)),
            box=float(config.get('box', 7.5)),
            cls=float(config.get('cls', 0.5)),
            dfl=float(config.get('dfl', 1.5)),
            hsv_h=float(config.get('hsv_h', 0.015)),
            hsv_s=float(config.get('hsv_s', 0.7)),
            hsv_v=float(config.get('hsv_v', 0.4)),
            degrees=float(config.get('degrees', 0)),
            translate=float(config.get('translate', 0.1)),
            scale=float(config.get('scale', 0.5)),
            shear=float(config.get('shear', 0)),
            perspective=float(config.get('perspective', 0)),
            flipud=float(config.get('flipud', 0)),
            fliplr=float(config.get('fliplr', 0.5)),
            mosaic=float(config.get('mosaic', 1)),
            mixup=float(config.get('mixup', 0)),
            project=runs_dir,
            verbose=True,
            exist_ok=True,
        )
        if device is not None:
            train_kwargs['device'] = device

        model.train(**train_kwargs)

        # Capture actual save dir (YOLO may append a number suffix if name already exists)
        try:
            _job['run_dir'] = str(model.trainer.save_dir)
        except Exception:
            _job['run_dir'] = os.path.join(runs_dir, run_name) if runs_dir else ''

        if _stop_event.is_set():
            _job['state'] = 'stopped'
            return

        search_root = _job['run_dir'] or runs_dir or tmp
        best_pts = list(Path(search_root).rglob('best.pt'))
        if best_pts and models_folder_id:
            # Use the latest token (may have been refreshed by /refresh-token during a long run)
            upload_token = _job.get('drive_token') or token
            upload_name  = f'{run_name}_best.pt'
            try:
                _log(f'Uploading {upload_name} to Drive...')
                _upload_file(upload_token, models_folder_id, str(best_pts[0]), upload_name)
                _log('Upload complete.')
                run_artifact_dir = _job['run_dir'] or str(best_pts[0].parent.parent)
                artifacts = _upload_run_artifacts(upload_token, models_folder_id, run_artifact_dir, run_name, _log)
                metrics_payload = {
                    'run_name': run_name, 'model_file': upload_name,
                    'base_model': base_model, 'task': task,
                    'epochs_completed': _job['epoch'],
                    'trained_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    'summary': _compute_summary(_job['metrics_history']),
                    'metrics_history': _job['metrics_history'],
                    'artifacts': artifacts,
                }
                _log('Uploading metrics JSON...')
                _upload_bytes(upload_token, models_folder_id, f'{run_name}_metrics.json',
                              'application/json', json.dumps(metrics_payload).encode())
            except Exception as up_err:
                _log(f'Warning: Drive upload failed ({up_err}). '
                     f'Model saved locally at {best_pts[0]}')
        elif not best_pts:
            _log('Warning: best.pt not found — training may not have completed.')

        _job['state'] = 'done'
        _log('Training complete.')

    except Exception as exc:
        _job['state'] = 'error'
        _log(f'Error: {exc}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if pp_tmp:
            shutil.rmtree(pp_tmp, ignore_errors=True)
        if cache_dir_to_release:
            shutil.rmtree(cache_dir_to_release, ignore_errors=True)
            _log('Released dataset cache.')

# ── Test runner ───────────────────────────────────────────────────────────────

def _run_test(data):
    global _test_job
    import base64, requests as req

    drive_token   = data.get('drive_token', '')
    model_file_id = data.get('model_file_id', '')
    model_name    = data.get('model_name', 'model.pt')
    local_model   = data.get('local_model', '').strip()
    test_data_dir = data.get('test_data_dir', '').strip()
    yaml_path_arg = data.get('yaml_path', '').strip()
    split         = data.get('split', 'test')
    conf          = float(data.get('conf', 0.001))
    iou           = float(data.get('iou', 0.6))

    def tlog(msg):
        _test_job['log'].append(msg)
        print(f'[TEST] {msg}')

    tmp = tempfile.mkdtemp(prefix='pavement_test_')
    try:
        # 1. Resolve model .pt
        if local_model and os.path.isfile(local_model):
            model_pt = local_model
            tlog(f'Using local model: {model_pt}')
        elif model_file_id and drive_token:
            model_pt = os.path.join(tmp, model_name)
            tlog(f'Downloading {model_name} from Drive...')
            r = req.get(
                f'https://www.googleapis.com/drive/v3/files/{model_file_id}?alt=media',
                headers={'Authorization': f'Bearer {drive_token}'}, timeout=300,
            )
            r.raise_for_status()
            with open(model_pt, 'wb') as f:
                f.write(r.content)
            tlog('Model downloaded.')
        else:
            _test_job['state'] = 'error'
            tlog('Error: No model specified.')
            return

        # 2. Validate test data dir
        if not test_data_dir or not os.path.isdir(test_data_dir):
            _test_job['state'] = 'error'
            tlog(f'Error: Test data folder not found: {test_data_dir!r}')
            return

        # 3. Find YAML
        if yaml_path_arg and os.path.isfile(yaml_path_arg):
            yaml_path = yaml_path_arg
        else:
            yamls = list(Path(test_data_dir).rglob('data.yaml')) or \
                    list(Path(test_data_dir).rglob('*.yaml'))
            if not yamls:
                _test_job['state'] = 'error'
                tlog('Error: No .yaml file found in the test data folder.')
                return
            yaml_path = str(yamls[0])

        _patch_yaml(yaml_path, test_data_dir)
        tlog(f'Dataset config: {yaml_path}')
        tlog(f'Running evaluation on {split} split (conf={conf}, iou={iou})...')

        if _test_stop.is_set():
            _test_job['state'] = 'stopped'; return

        # 4. Run YOLO val()
        from ultralytics import YOLO
        model = YOLO(model_pt)

        run_dir = os.path.join(tmp, 'eval')
        results = model.val(
            data=yaml_path,
            split=split,
            conf=conf,
            iou=iou,
            project=tmp,
            name='eval',
            exist_ok=True,
            plots=True,
            verbose=True,
            save_json=False,
        )

        if _test_stop.is_set():
            _test_job['state'] = 'stopped'; return

        tlog('Evaluation complete — collecting results...')

        # 5. Scalar metrics from results_dict
        metrics = {}
        rd = getattr(results, 'results_dict', {}) or {}
        for k, v in rd.items():
            try: metrics[k] = round(float(v), 6)
            except Exception: pass

        # Ensure key summary fields exist explicitly
        box = getattr(results, 'box', None)
        seg = getattr(results, 'seg', None)
        if box:
            for attr, key in [('map50','box/mAP50'), ('map','box/mAP50-95'),
                               ('mp','box/precision'), ('mr','box/recall')]:
                try: metrics[key] = round(float(getattr(box, attr, 0) or 0), 6)
                except Exception: pass
        if seg:
            for attr, key in [('map50','seg/mAP50'), ('map','seg/mAP50-95'),
                               ('mp','seg/precision'), ('mr','seg/recall')]:
                try: metrics[key] = round(float(getattr(seg, attr, 0) or 0), 6)
                except Exception: pass

        # 6. Per-class metrics
        nms = getattr(model, 'names', {}) or {}
        class_metrics, class_metrics_seg = {}, {}

        def _collect_cls(metric_obj, out):
            ap_ci = getattr(metric_obj, 'ap_class_index', None)
            if ap_ci is None or not hasattr(metric_obj, 'class_result'):
                return
            for i in range(len(ap_ci)):
                try:
                    res  = metric_obj.class_result(i)
                    name = nms.get(int(ap_ci[i]), str(ap_ci[i]))
                    out[name] = {
                        'p':    round(float(res[0]), 4),
                        'r':    round(float(res[1]), 4),
                        'ap50': round(float(res[2]), 4),
                        'ap':   round(float(res[3]), 4),
                    }
                except Exception: pass

        if box: _collect_cls(box, class_metrics)
        if seg: _collect_cls(seg, class_metrics_seg)

        # 7. Collect result images
        IMAGE_ORDER = [
            'confusion_matrix_normalized.png',
            'confusion_matrix.png',
            'PR_curve.png',
            'F1_curve.png',
            'P_curve.png',
            'R_curve.png',
        ]
        images = {}
        for name in IMAGE_ORDER:
            path = os.path.join(run_dir, name)
            if os.path.isfile(path):
                ext  = name.rsplit('.', 1)[-1].lower()
                mime = 'image/jpeg' if ext in ('jpg', 'jpeg') else 'image/png'
                with open(path, 'rb') as f:
                    images[name] = f'data:{mime};base64,{base64.b64encode(f.read()).decode()}'

        _test_job.update({
            'state':             'done',
            'metrics':           metrics,
            'class_metrics':     class_metrics,
            'class_metrics_seg': class_metrics_seg,
            'images':            images,
        })
        tlog('Done.')

    except Exception as exc:
        _test_job['state'] = 'error'
        _test_job['log'].append(f'Error: {exc}')
        print(f'[TEST ERROR] {exc}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def _smooth_curve(y, f=0.1):
    """Box filter of fraction f — mirrors ultralytics.utils.metrics.smooth()."""
    import numpy as np
    nf = round(len(y) * f * 2) // 2 + 1  # number of filter elements (must be odd)
    p  = np.ones(nf // 2)
    yp = np.concatenate((p * y[0], y, p * y[-1]), 0)
    return np.convolve(yp, np.ones(nf) / nf, mode='valid')

def _best_f1_threshold(metric_obj, names):
    """Given a populated ultralytics Metric (box or seg), find the confidence
    threshold that maximizes mean F1 across classes, plus per-class stats at
    that threshold and a downsampled curve for charting."""
    import numpy as np

    f1_curve = np.asarray(getattr(metric_obj, 'f1_curve', []))
    p_curve  = np.asarray(getattr(metric_obj, 'p_curve', []))
    r_curve  = np.asarray(getattr(metric_obj, 'r_curve', []))
    px       = np.asarray(getattr(metric_obj, 'px', []))
    ap_ci    = getattr(metric_obj, 'ap_class_index', [])

    if f1_curve.size == 0 or px.size == 0:
        return None

    mean_f1  = f1_curve.mean(0)
    mean_p   = p_curve.mean(0)
    mean_r   = r_curve.mean(0)
    idx      = int(_smooth_curve(mean_f1, 0.1).argmax())

    per_class = {}
    for i, ci in enumerate(ap_ci):
        name = names.get(int(ci), str(ci))
        per_class[name] = {
            'precision': round(float(p_curve[i, idx]), 4),
            'recall':    round(float(r_curve[i, idx]), 4),
            'f1':        round(float(f1_curve[i, idx]), 4),
        }

    # Downsample the full 1000-point curve for charting.
    step  = max(1, len(px) // 200)
    curve = {
        'conf':      [round(float(v), 4) for v in px[::step]],
        'f1':        [round(float(v), 4) for v in mean_f1[::step]],
        'precision': [round(float(v), 4) for v in mean_p[::step]],
        'recall':    [round(float(v), 4) for v in mean_r[::step]],
    }

    return {
        'best_conf':      round(float(px[idx]), 4),
        'best_f1':        round(float(mean_f1[idx]), 4),
        'best_precision': round(float(mean_p[idx]), 4),
        'best_recall':    round(float(mean_r[idx]), 4),
        'per_class':      per_class,
        'curve':          curve,
    }

def _run_optimize_threshold(data):
    global _thresh_job
    import base64, requests as req

    drive_token   = data.get('drive_token', '')
    model_file_id = data.get('model_file_id', '')
    model_name    = data.get('model_name', 'model.pt')
    local_model   = data.get('local_model', '').strip()
    test_data_dir = data.get('test_data_dir', '').strip()
    yaml_path_arg = data.get('yaml_path', '').strip()
    split         = data.get('split', 'test')
    iou           = float(data.get('iou', 0.6))

    def tlog(msg):
        _thresh_job['log'].append(msg)
        print(f'[THRESH] {msg}')

    tmp = tempfile.mkdtemp(prefix='pavement_thresh_')
    try:
        # 1. Resolve model .pt
        if local_model and os.path.isfile(local_model):
            model_pt = local_model
            tlog(f'Using local model: {model_pt}')
        elif model_file_id and drive_token:
            model_pt = os.path.join(tmp, model_name)
            tlog(f'Downloading {model_name} from Drive...')
            r = req.get(
                f'https://www.googleapis.com/drive/v3/files/{model_file_id}?alt=media',
                headers={'Authorization': f'Bearer {drive_token}'}, timeout=300,
            )
            r.raise_for_status()
            with open(model_pt, 'wb') as f:
                f.write(r.content)
            tlog('Model downloaded.')
        else:
            _thresh_job['state'] = 'error'
            tlog('Error: No model specified.')
            return

        # 2. Validate test data dir
        if not test_data_dir or not os.path.isdir(test_data_dir):
            _thresh_job['state'] = 'error'
            tlog(f'Error: Test data folder not found: {test_data_dir!r}')
            return

        # 3. Find YAML
        if yaml_path_arg and os.path.isfile(yaml_path_arg):
            yaml_path = yaml_path_arg
        else:
            yamls = list(Path(test_data_dir).rglob('data.yaml')) or \
                    list(Path(test_data_dir).rglob('*.yaml'))
            if not yamls:
                _thresh_job['state'] = 'error'
                tlog('Error: No .yaml file found in the test data folder.')
                return
            yaml_path = str(yamls[0])

        _patch_yaml(yaml_path, test_data_dir)
        tlog(f'Dataset config: {yaml_path}')
        tlog(f'Sweeping confidence threshold on {split} split (iou={iou})...')

        if _thresh_stop.is_set():
            _thresh_job['state'] = 'stopped'; return

        # 4. Run YOLO val() at a low confidence so the full F1-vs-confidence curve is captured
        from ultralytics import YOLO
        model = YOLO(model_pt)

        run_dir = os.path.join(tmp, 'eval')
        results = model.val(
            data=yaml_path,
            split=split,
            conf=0.001,
            iou=iou,
            project=tmp,
            name='eval',
            exist_ok=True,
            plots=True,
            verbose=True,
            save_json=False,
        )

        if _thresh_stop.is_set():
            _thresh_job['state'] = 'stopped'; return

        tlog('Evaluation complete — locating optimal F1 threshold...')

        nms = getattr(model, 'names', {}) or {}
        box = getattr(results, 'box', None)
        seg = getattr(results, 'seg', None)

        box_result = _best_f1_threshold(box, nms) if box is not None else None
        seg_result = _best_f1_threshold(seg, nms) if seg is not None else None

        if box_result is None:
            _thresh_job['state'] = 'error'
            tlog('Error: No F1 curve data available — check the dataset and model.')
            return

        # 5. Collect result images
        IMAGE_ORDER = [
            'F1_curve.png',
            'PR_curve.png',
            'P_curve.png',
            'R_curve.png',
            'confusion_matrix_normalized.png',
            'confusion_matrix.png',
        ]
        images = {}
        for name in IMAGE_ORDER:
            path = os.path.join(run_dir, name)
            if os.path.isfile(path):
                ext  = name.rsplit('.', 1)[-1].lower()
                mime = 'image/jpeg' if ext in ('jpg', 'jpeg') else 'image/png'
                with open(path, 'rb') as f:
                    images[name] = f'data:{mime};base64,{base64.b64encode(f.read()).decode()}'

        _thresh_job.update({
            'state':  'done',
            'box':    box_result,
            'seg':    seg_result,
            'images': images,
        })
        tlog(f"Done. Optimal confidence threshold: {box_result['best_conf']:.3f} "
             f"(F1={box_result['best_f1']:.4f})")

    except Exception as exc:
        _thresh_job['state'] = 'error'
        _thresh_job['log'].append(f'Error: {exc}')
        print(f'[THRESH ERROR] {exc}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import argparse
    # Strip URL protocol arguments (e.g. trainertool://start when launched via protocol)
    clean_args = [a for a in sys.argv[1:] if not a.startswith('trainertool://')]
    parser = argparse.ArgumentParser(description='Pavement Dataset Tool — Training Server')
    parser.add_argument('--port', type=int, default=7860)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args(clean_args)

    # Exit early if server is already running on the requested port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as _s:
        _s.settimeout(0.3)
        if _s.connect_ex((args.host, args.port)) == 0:
            print(f'Server already running on {args.host}:{args.port} — exiting.')
            sys.exit(0)

    _register_protocol()
    print(f'Pavement Training Server  http://{args.host}:{args.port}')
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False)
