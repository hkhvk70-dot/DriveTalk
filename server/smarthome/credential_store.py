"""Authenticated encryption, atomic persistence and inter-process account lock.

No plaintext auth.json is ever written by this implementation. Windows tests
exercise encryption/locking, not Linux ownership or Windows ACL guarantees.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import stat
import tempfile

from cryptography.fernet import Fernet


def validate_auth(data):
    fields = ('ua', 'ssecurity', 'userId', 'cUserId', 'serviceToken')
    if not isinstance(data, dict) or any(data.get(key) in (None, '') for key in fields):
        raise ValueError('认证数据不完整')
    if any(not isinstance(data[key], str) for key in ('ua', 'ssecurity', 'cUserId', 'serviceToken')):
        raise ValueError('认证字段类型错误')
    if type(data['userId']) not in (str, int):
        raise ValueError('账号编号类型错误')
    return data


class CredentialStore:
    def __init__(self, directory):
        path = Path(directory)
        if path.is_symlink():
            raise ValueError('凭证目录不能是符号链接')
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory = path.resolve(strict=True)
        self._check(self.directory.stat(), directory=True)
        self.key = self.directory / 'credential.key'
        self.auth = self.directory / 'auth.enc'

    @staticmethod
    def _check(info, directory=False):
        if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
            raise ValueError('凭证路径类型错误')
        if os.name == 'posix' and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077):
            raise PermissionError('凭证目录/文件所有者或权限错误')

    def _read(self, path):
        if path.is_symlink():
            raise ValueError('凭证文件不能是符号链接')
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as stream:
            self._check(os.fstat(stream.fileno()))
            data = stream.read(1048577)
            if len(data) > 1048576:
                raise ValueError('凭证异常过大')
            return data

    def initialize(self):
        """Explicit login only. Missing keys must never replace an existing key."""
        if self.key.exists():
            Fernet(self._read(self.key))
            return
        if self.auth.exists() or (self.directory / 'inventory.enc').exists():
            raise ValueError('已有密文但密钥丢失，禁止创建替代密钥')
        fd = os.open(self.key, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                     0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(Fernet.generate_key())
            stream.flush()
            os.fsync(stream.fileno())

    def save(self, data):
        validate_auth(data)
        self._save_document(self.auth, data)

    def save_inventory(self, data):
        """Account metadata is private too. Caller must hold exclusive()."""
        if not isinstance(data, dict) or data.get('version') != 1:
            raise ValueError('设备清单格式错误')
        self._save_document(self.directory / 'inventory.enc', data)

    def load_inventory(self):
        data = Fernet(self._read(self.key)).decrypt(
            self._read(self.directory / 'inventory.enc'))
        return json.loads(data)

    def _save_document(self, destination, data):
        if destination.is_symlink():
            raise ValueError('密文文件不能是符号链接')
        encoded = json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(encoded) > 512000:
            raise ValueError('认证异常过大')
        encrypted = Fernet(self._read(self.key)).encrypt(encoded)
        fd, name = tempfile.mkstemp(prefix='.auth-', dir=self.directory)
        temporary = Path(name)
        try:
            with os.fdopen(fd, 'wb') as stream:
                if os.name == 'posix':
                    os.fchmod(stream.fileno(), 0o600)
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            if os.name == 'posix':
                directory_fd = os.open(self.directory, os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    def load(self):
        data = Fernet(self._read(self.key)).decrypt(self._read(self.auth))
        return validate_auth(json.loads(data))

    @contextmanager
    def exclusive(self):
        path = self.directory / 'credential.lock'
        if path.is_symlink():
            raise ValueError('锁文件不能是符号链接')
        fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        acquired = False
        try:
            self._check(os.fstat(fd))
            if os.name == 'posix':
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                import msvcrt
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b'0')
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            acquired = True
            yield
        finally:
            if acquired and os.name != 'posix':
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            os.close(fd)
