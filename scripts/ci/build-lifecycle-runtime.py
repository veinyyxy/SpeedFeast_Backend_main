"""Build-only minimal runtime overlay with honest Debian dependency metadata.

Never copy a shell/package manager/Perl or remove scanner metadata. The fixed
upstream Python installation is not a Debian package; record its source/image
and version separately instead of inventing a dpkg package version.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

BASE = Path('/runtime-base')
OUTPUT = Path('/runtime-overlay')
PG_STATUS = Path('/pg-source-status')
LIB_ROOT = Path('/usr/lib/x86_64-linux-gnu')
PG_IMAGE = 'postgres:16.14-trixie@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b'
PYTHON_IMAGE = 'python:3.14.8-slim-trixie@sha256:f85c5697265c178cc6887276c55fe16cf3d14ca35c3df6a5eab3b360534a55d2'


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def status_packages(text):
    result = {}
    for paragraph in text.strip().split('\n\n'):
        fields = dict(re.findall(r'^([^\s:]+): (.*)$', paragraph, re.M))
        if 'Package' in fields:
            result[fields['Package']] = (paragraph + '\n', fields)
    return result


def copy(source, target):
    destination = OUTPUT / target.lstrip('/')
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination, follow_symlinks=True)
    return {'path': target, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}


def main():
    if sys.version_info[:3] != (3, 14, 8) or OUTPUT.exists() or not BASE.is_dir():
        raise ValueError('Fixed build source/fresh output required')
    OUTPUT.mkdir()
    pg_version = command('/usr/local/bin/pg_restore16', '--version').strip()
    if not re.fullmatch(r'pg_restore \(PostgreSQL\) 16\.14(?: \(Debian 16\.14-\d+\.pgdg13\+\d+\))?', pg_version):
        raise ValueError('PG patch/source changed')
    files = [copy('/usr/local/bin/pg_restore16', '/usr/local/bin/pg_restore16'),
             copy('/usr/local/bin/python3.14', '/usr/local/bin/python3.14'),
             copy('/usr/local/lib/libpython3.14.so.1.0', '/usr/lib/x86_64-linux-gnu/libpython3.14.so.1.0')]
    (OUTPUT / 'usr/bin').mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'usr/bin/python3').symlink_to('../local/bin/python3.14')
    python_library = OUTPUT / 'usr/local/lib/python3.14'
    shutil.copytree('/usr/local/lib/python3.14', python_library,
                    ignore=shutil.ignore_patterns('site-packages', '__pycache__', '*.pyc'))
    (python_library / 'site-packages').mkdir(exist_ok=True)
    # CPython's exact patched interpreter + stdlib are kept, including ssl;
    # no pip/npm installation tools are copied into the runtime.
    binaries = [Path('/usr/local/bin/pg_restore16'), Path('/usr/local/bin/python3.14'),
                Path('/usr/local/lib/libpython3.14.so.1.0')]
    binaries += sorted(Path('/usr/local/lib/python3.14/lib-dynload').glob('*.so'))
    dependencies = set()
    for binary in binaries:
        listing = command('ldd', str(binary))
        if 'not found' in listing:
            raise ValueError('Unresolved runtime dependency')
        dependencies.update(re.findall(r'=> (/[^\s]+)', listing))
    installed = status_packages(Path('/var/lib/dpkg/status').read_text())
    original_pg = status_packages(PG_STATUS.read_text())
    metadata = {'postgresql-client-16': original_pg['postgresql-client-16']}
    for library in sorted(dependencies):
        source = Path(library)
        name = source.name
        # Prefer the newer distroless-owned base libraries. Never overwrite
        # libc/loader/ssl/libgcc and misreport them as the base's patched bytes.
        if (BASE / 'usr/lib/x86_64-linux-gnu' / name).exists() or (BASE / library.lstrip('/')).exists():
            continue
        if name.startswith('libpython3.14.'):
            continue  # explicitly copied and pinned as upstream CPython above
        files.append(copy(source, str(LIB_ROOT / name)))
        if name.startswith('libpq.so.'):
            metadata['libpq5'] = original_pg['libpq5']
        else:
            owner = command('dpkg-query', '-S', str(source.resolve())).split(': ', 1)[0].split(':', 1)[0]
            metadata[owner] = installed[owner]
    packages = []
    for package, (paragraph, fields) in sorted(metadata.items()):
        destination = OUTPUT / 'var/lib/dpkg/status.d' / package
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(paragraph)
        packages.append({'name': package, 'version': fields['Version'], 'architecture': fields['Architecture']})
    (OUTPUT / 'usr/local/share').mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'usr/local/share/lifecycle-runtime-provenance.json').write_text(json.dumps({
        'schemaVersion': 1, 'pythonVersion': '3.14.8', 'pythonSourceImage': PYTHON_IMAGE,
        'pgRestoreVersion': '16.14', 'pgSourceImage': PG_IMAGE, 'debianPackages': packages,
        'copiedBinaryFiles': files, 'basePackageMetadataPreserved': True,
        'upstreamPythonIsDebianPackage': False}, sort_keys=True))
    (OUTPUT / 'tmp/tenant-lifecycle').mkdir(parents=True)
    (OUTPUT / 'tmp/tenant-lifecycle').chmod(0o700)
    print(json.dumps({'outcome': 'MINIMAL_RUNTIME_OVERLAY_BUILT', 'python': '3.14.8',
                      'pgRestore': '16.14', 'debianPackages': packages}))


if __name__ == '__main__':
    main()
