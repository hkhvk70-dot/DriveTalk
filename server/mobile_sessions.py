"""Opaque, revocable 30-day owner sessions. Raw credentials are never persisted."""
import hashlib
from contextlib import contextmanager
import hmac
from http.cookies import SimpleCookie, CookieError
import re
import secrets
import sqlite3
import threading
import time

COOKIE_NAME = '__Host-DriveTalkSession'
TTL = 30 * 24 * 60 * 60

def cookie_value(header):
    try:
        cookie = SimpleCookie()
        cookie.load(header or '')
        value = cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else ''
        return value if re.fullmatch(r'[A-Za-z0-9_-]{43}', value) else ''
    except (CookieError, ValueError):
        return ''

def session_cookie(value='', age=0):
    return f'{COOKIE_NAME}={value}; Path=/; Max-Age={age}; Secure; HttpOnly; SameSite=Strict'

class MobileSessions:
    def __init__(self, path, owner_token, clock=time.time):
        self.path, self.owner_token, self.clock = path, owner_token, clock
        self.lock = threading.Lock()
        self.attempts = []
        with self.database() as db:
            db.execute('CREATE TABLE IF NOT EXISTS mobile_sessions (digest TEXT PRIMARY KEY, expires REAL NOT NULL, owner TEXT NOT NULL)')
        path.chmod(0o600)

    @contextmanager
    def database(self):
        db = sqlite3.connect(self.path)
        try:
            with db:
                yield db
        finally:
            db.close()

    def fingerprint(self):
        return hashlib.sha256(self.owner_token().encode()).hexdigest()

    def allow_login(self):
        with self.lock:
            now = self.clock()
            self.attempts = [when for when in self.attempts if when > now - 300]
            if len(self.attempts) >= 20:
                return False
            self.attempts.append(now)
            return True

    def create(self):
        value = secrets.token_urlsafe(32)
        digest = hashlib.sha256(value.encode()).hexdigest()
        with self.lock, self.database() as db:
            db.execute('DELETE FROM mobile_sessions WHERE expires <= ? OR owner != ?', (self.clock(), self.fingerprint()))
            db.execute('INSERT INTO mobile_sessions VALUES (?, ?, ?)', (digest, self.clock() + TTL, self.fingerprint()))
            db.execute('DELETE FROM mobile_sessions WHERE digest NOT IN (SELECT digest FROM mobile_sessions ORDER BY expires DESC LIMIT 20)')
        return value

    def valid(self, cookie_header):
        value = cookie_value(cookie_header)
        if not value:
            return False
        digest = hashlib.sha256(value.encode()).hexdigest()
        with self.database() as db:
            row = db.execute('SELECT expires, owner FROM mobile_sessions WHERE digest=?', (digest,)).fetchone()
        return bool(row and row[0] > self.clock() and hmac.compare_digest(row[1], self.fingerprint()))

    def revoke(self, cookie_header):
        value = cookie_value(cookie_header)
        with self.database() as db:
            db.execute('DELETE FROM mobile_sessions WHERE digest=?', (hashlib.sha256(value.encode()).hexdigest(),))
