"""Owner UI account jobs. Child processes isolate blocking Xiaomi SDK calls.

No device writes and no AI tool activation. Requires an explicit server-side
SMARTHOME_CREDENTIAL_DIR and explicit authenticated POST before cloud access.
"""
import base64
import hashlib
import importlib.util
import io
import multiprocessing
from pathlib import Path
import threading
import time
from urllib.parse import urlparse

from .credential_store import CredentialStore, validate_auth
from .discovery import prepare_inventory, public_inventory, sync_account
from .mijia_backend import secure_api


def safe_login_url(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4000:
        raise ValueError('二维码链接错误')
    parsed = urlparse(value)
    if (parsed.scheme != 'https' or parsed.hostname not in ('account.xiaomi.com', 'ak.account.xiaomi.com')
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError('二维码来源错误')
    return value


def account_worker(connection, directory, operation):
    """Private SDK hooks verified against upstream source; real runtime untested."""
    api = None
    try:
        store = CredentialStore(directory)
        with store.exclusive():
            if operation == 'login':
                store.initialize()
            api = secure_api(store, login=operation == 'login')
            if operation == 'login':
                if not all(callable(getattr(api, name, None)) for name in
                           ('_get_qr_login_data', '_complete_qr_login')):
                    raise RuntimeError('SDK QR hooks unavailable')
                login_data = api._get_qr_login_data()
                if not login_data.get('refreshed'):
                    url = safe_login_url(login_data.get('loginUrl'))
                    # Render locally, no credential-bearing upstream image URL.
                    import qrcode
                    from qrcode.image.svg import SvgPathImage
                    image = qrcode.make(url, image_factory=SvgPathImage)
                    buffer = io.BytesIO(); image.save(buffer)
                    connection.send({'state': 'waiting_scan', 'loginUrl': url,
                                     'qrSvg': base64.b64encode(buffer.getvalue()).decode('ascii')})
                    store.save(validate_auth(api._complete_qr_login(login_data)))
                connection.send({'state': 'syncing'})
            sync_account(api, store)
        connection.send({'state': 'done'})
    except Exception:
        # Never forward upstream errors, auth dictionaries or polling URLs.
        connection.send({'state': 'failed'})
    finally:
        session = getattr(api, 'session', None)
        if session is not None:
            session.close()
        connection.close()


class AccountUI:
    def __init__(self, directory=None, *, context=None, clock=time.monotonic, ready=None):
        self.directory = Path(directory) if directory else None
        if self.directory is not None and not self.directory.is_absolute():
            raise ValueError('米家凭证路径必须为绝对路径')
        self.context = context or multiprocessing.get_context('spawn')
        self.clock = clock
        self.ready = ready or (lambda: importlib.util.find_spec('mijiaAPI') is not None
                              and importlib.util.find_spec('qrcode') is not None)
        self.lock = threading.RLock()
        self.process = self.pipe = None
        self.started = 0.0
        self.next_start = 0.0
        self.job = {'state': 'idle'}
        self.control_ready = lambda: False

    def _stop(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate(); self.process.join(timeout=0.5)
                if self.process.is_alive():
                    self.process.kill(); self.process.join(timeout=0.5)
            else:
                self.process.join(timeout=0)
            if self.process.is_alive():
                raise RuntimeError('账号进程未停止')
            self.process.close(); self.process = None
        if self.pipe is not None:
            self.pipe.close(); self.pipe = None

    def _update(self):
        if self.process is None:
            return
        if self.clock() - self.started > 180:
            self._stop(); self.job = {'state': 'timeout'}
            return
        try:
            while self.pipe.poll():
                event = self.pipe.recv()
                state = event.get('state') if isinstance(event, dict) else None
                if state not in ('waiting_scan', 'syncing', 'done', 'failed'):
                    continue
                self.job = {'state': state}
                if state == 'waiting_scan':
                    self.job['loginUrl'] = safe_login_url(event['loginUrl'])
                    svg = event.get('qrSvg')
                    if not isinstance(svg, str) or len(svg) > 200000:
                        raise ValueError('QR image too large')
                    self.job['qrSvg'] = svg
        except EOFError:
            pass
        except Exception:
            self._stop(); self.job = {'state': 'failed'}
            return
        if not self.process.is_alive():
            self._stop()
            if self.job['state'] not in ('done', 'failed'):
                self.job = {'state': 'failed'}

    def status(self):
        with self.lock:
            self._update()
            available = self.directory is not None and self.ready()
            result = {'available': available, 'configured': False,
                      'job': dict(self.job), 'devices': [], 'syncedAt': None,
                      'controlConnected': False,
                      'controlGranted': False,
                      'retryAfter': max(0, int(self.next_start - self.clock() + 0.999))}
            if self.directory and self.directory.exists():
                try:
                    store = CredentialStore(self.directory)
                    auth = store.load()  # Validate cipher/key, not cloud token validity.
                    result['configured'] = True
                    inventory = store.load_inventory()
                    if inventory.get('account_fingerprint') != hashlib.sha256(str(auth['userId']).encode()).hexdigest():
                        raise ValueError('设备清单与当前账号不一致')
                    inventory = prepare_inventory(inventory, store.directory)
                    result['devices'] = public_inventory(inventory)['devices']
                    result['syncedAt'] = inventory['synced_at']
                    result['controlGranted'] = inventory.get('control_granted') is True
                except FileNotFoundError:
                    pass
                except Exception:
                    result['storageError'] = True
            result['controlConnected'] = bool(result['configured'] and result['devices']
                                              and not result.get('storageError') and self.control_ready())
            result['controlGranted'] = result['controlGranted'] and result['controlConnected']
            return result

    def start(self, operation):
        if operation not in ('login', 'sync'):
            raise ValueError('账号操作无效')
        with self.lock:
            self._update()
            if self.directory is None or not self.ready():
                raise ValueError('米家后端尚未配置或依赖未安装')
            if self.process is not None:
                raise ValueError('账号任务正在进行，请勿重复提交')
            if self.clock() < self.next_start:
                raise ValueError('账号操作冷却中，请稍后再试')
            if operation == 'sync' and not (self.directory / 'auth.enc').is_file():
                raise ValueError('请先扫码登录米家')
            parent, child = self.context.Pipe(duplex=False)
            process = self.context.Process(target=account_worker,
                                           args=(child, str(self.directory), operation), daemon=True)
            try:
                process.start()
            except Exception:
                parent.close(); child.close(); process.close()
                raise ValueError('账号任务启动失败') from None
            child.close()
            self.process, self.pipe = process, parent
            self.started = self.clock(); self.next_start = self.started + 30
            self.job = {'state': 'starting' if operation == 'login' else 'syncing'}
            # Independent watchdog: timeout also works after user leaves page.
            threading.Thread(target=self._watchdog, args=(process,), daemon=True).start()
            return self.status()

    def _watchdog(self, process):
        while True:
            time.sleep(1)
            with self.lock:
                if self.process is not process:
                    return
                self._update()

    def cancel(self):
        with self.lock:
            self._stop(); self.job = {'state': 'cancelled'}
            # Already-saved auth/inventory remains; cancel is not logout.
            return self.status()

    def select(self, aliases, *, enable_control=False):
        if type(enable_control) is not bool or (enable_control and not self.control_ready()):
            raise ValueError('家居控制尚未就绪')
        if not isinstance(aliases, list) or len(aliases) > 2000:
            raise ValueError('设备选择错误')
        if any(not isinstance(a, str) for a in aliases) or len(aliases) != len(set(aliases)):
            raise ValueError('设备选择错误')
        with self.lock:
            self._update()
            if self.directory is None or self.process is not None:
                raise ValueError('请先完成账号同步')
            store = CredentialStore(self.directory)
            with store.exclusive():
                inventory = store.load_inventory()
                if inventory.get('account_fingerprint') != hashlib.sha256(str(store.load()['userId']).encode()).hexdigest():
                    raise ValueError('请重新同步当前账号')
                inventory = prepare_inventory(inventory, store.directory)
                devices = inventory['devices']
                if any(a not in devices or not devices[a].get('binding') for a in aliases):
                    raise ValueError('存在尚未支持控制的设备')
                for alias, device in devices.items():
                    device['enabled'] = alias in aliases
                # Explicit saves (including empty/revoked selections) override
                # the user's default-on policy, across restart and same-account sync.
                inventory['control_selection_version'] = 1
                inventory['control_granted'] = enable_control and bool(aliases)
                store.save_inventory(inventory)
            return self.status()
