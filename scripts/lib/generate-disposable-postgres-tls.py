"""Generate TLS assets only for a fresh local PostgreSQL test directory."""
import datetime
import ipaddress
import pathlib
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
workshop = pathlib.Path('F:/ChatGPT_workshop').resolve(strict=True)
if not root.is_relative_to(workshop) or root == workshop:
    raise SystemExit('TLS test directory must be inside the artifact workspace')
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
now = datetime.datetime.now(datetime.timezone.utc)
certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
               .public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(now - datetime.timedelta(minutes=5))
               .not_valid_after(now + datetime.timedelta(days=2))
               .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
               .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),
                    x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
               .sign(key, hashes.SHA256()))
for filename, content in [('server.crt', certificate.public_bytes(serialization.Encoding.PEM)),
                          ('server.key', key.private_bytes(serialization.Encoding.PEM,
                            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))]:
    with (root / filename).open('xb') as handle:
        handle.write(content)
    (root / filename).chmod(0o600)
print('Disposable loopback TLS assets generated; no system trust-store changes.')
