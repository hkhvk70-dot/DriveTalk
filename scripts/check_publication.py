"""Text-only release guard. No network or device commands; never prints matches.

Optional PRIVATE_DENYLIST points to a private, untracked newline-separated list
of identities/endpoints that must not appear. Keep that list outside this repo.
This guard complements review, it is not an exhaustive secret scanner.
"""
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PRUNE = {'.git', 'node_modules', 'dist', 'build', '.gradle', '.idea', '.venv', 'venv', '__pycache__'}
TEXT = {'.py', '.ts', '.tsx', '.css', '.java', '.xml', '.html', '.json', '.yaml', '.yml', '.toml', '.kts', '.properties', '.md', '.txt', '.example', '.sh', '.ps1'}
SPECIAL = {'.gitignore', '.gitattributes', 'LICENSE', 'NOTICE'}
FORBIDDEN = {'.pem', '.key', '.jks', '.keystore', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3', '.apk', '.aab', '.ipa', '.glb', '.gltf', '.jar', '.aar', '.zip', '.log', '.har', '.mp3', '.wav', '.mp4'}
RULES = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'),
    'credential': re.compile(r'\b(?:sk-[\w-]{24,}|xai-[\w-]{24,}|gh[pousr]_[\w]{20,}|AKIA[A-Z0-9]{16})\b'),
    'jwt': re.compile(r'\beyJ[\w-]{30,}\.[\w-]{30,}'),
}


def candidate_paths():
    # Never treat a parent working tree as this new repository's index.
    if (ROOT / '.git').exists():
        result = subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-z'], check=True, capture_output=True)
        return [ROOT / name for name in result.stdout.decode().split('\0') if name]
    paths = []
    for base, dirs, files in os.walk(ROOT, followlinks=False):
        dirs[:] = [name for name in dirs if name not in PRUNE]
        paths.extend(Path(base) / name for name in files)
    return paths


def main():
    deny_path = os.environ.get('PRIVATE_DENYLIST')
    denied = []
    if deny_path:
        source = Path(deny_path).resolve(strict=True)
        if source == ROOT or ROOT in source.parents:
            raise ValueError('Private denylist must be outside the repository')
        denied = [line.strip().casefold() for line in source.read_text(encoding='utf-8').splitlines() if line.strip()]
    findings = []
    paths = candidate_paths()
    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        if any(item in relative.casefold() for item in denied):
            findings.append(('redacted-path', 0, 'private-path'))
            continue
        if any(part in PRUNE for part in Path(relative).parts):
            findings.append((relative, 0, 'tracked-build-or-cache'))
            continue
        if path.is_symlink() or path.suffix.lower() in FORBIDDEN or (path.name.startswith('.env') and path.name != '.env.example'):
            findings.append((relative, 0, 'excluded-file'))
            continue
        if path.suffix not in TEXT and path.name not in SPECIAL:
            findings.append((relative, 0, 'non-allowlisted-file'))
            continue
        try:
            content = path.read_text(encoding='utf-8')
            if (ROOT / '.git').exists():
                # Audit the exact staged blob, not merely a cleaned working copy.
                staged = subprocess.run(['git', '-C', str(ROOT), 'show', ':' + relative],
                                        check=True, capture_output=True).stdout.decode('utf-8')
                if staged.replace('\r\n', '\n') != content.replace('\r\n', '\n'):
                    findings.append((relative, 0, 'index-worktree-mismatch'))
                content = staged
        except (UnicodeError, OSError, subprocess.CalledProcessError):
            findings.append((relative, 0, 'unreadable-text'))
            continue
        for number, line in enumerate(content.splitlines(), 1):
            for name, pattern in RULES.items():
                if pattern.search(line):
                    findings.append((relative, number, name))
            if any(item in line.casefold() for item in denied):
                findings.append((relative, number, 'private-denylist'))
    for path, line, reason in findings:
        print(f'{path}:{line}: {reason}')
    print(f'Checked {len(paths)} candidate files; {len(findings)} blocking findings. Values were not printed.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
