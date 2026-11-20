#!/usr/bin/env python3
"""Publish and manage artifacts through the Artifacts Share API."""

import argparse
import contextlib
from http.client import HTTPException
import json
import os
from pathlib import Path
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID
from zipfile import BadZipFile, ZipFile


VISIBILITIES = ('private', 'password', 'public')
METADATA = ('title', 'visibility', 'entry', 'spa_fallback', 'indexable')


class ShareError(Exception):
  pass


class NoRedirect(HTTPRedirectHandler):
  def redirect_request(self, req, fp, code, msg, headers, newurl):
    return None


def parse_origin(value):
  try:
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    port = parsed.port
  except ValueError:
    raise ShareError('Expected an HTTPS admin origin, without /api/v1 or a share path.') from None
  loopback = host in ('localhost', '127.0.0.1', '::1') or host.endswith('.localhost')
  if (
    not host or parsed.username is not None or parsed.path not in ('', '/')
    or parsed.query or parsed.fragment or '\\' in value
    or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value)
    or (parsed.scheme != 'https' and not (loopback and parsed.scheme == 'http'))
  ):
    raise ShareError('Expected an HTTPS admin origin, without /api/v1 or a share path.')
  authority = f'[{host}]' if ':' in host else host
  default_port = 443 if parsed.scheme == 'https' else 80
  if port is not None and port != default_port:
    authority += f':{port}'
  return f'{parsed.scheme}://{authority}'


def connection_settings():
  origin = os.environ.get('ARTIFACTS_SHARE_URL', '').strip()
  token = os.environ.get('ARTIFACTS_SHARE_TOKEN', '').strip()
  if not origin or not token:
    override = os.environ.get('ARTIFACTS_SHARE_CONFIG', '').strip()
    path = Path(override).expanduser() if override else Path.home() / '.config/artifacts-share/config.json'
    try:
      config = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
      if override:
        raise ShareError(f'Config file does not exist: {path}') from None
      config = {}
    except (OSError, ValueError):
      raise ShareError(f'Could not read JSON config: {path}') from None
    if not isinstance(config, dict) or any(not isinstance(config.get(key, ''), str) for key in ('url', 'token')):
      raise ShareError(f'Expected a JSON object with string url and token fields in {path}.')
    file_origin = config.get('url', '').strip()
    file_token = config.get('token', '').strip()
    if origin and not token and file_token and file_origin and parse_origin(origin) != parse_origin(file_origin):
      raise ShareError('Set ARTIFACTS_SHARE_TOKEN when overriding the configured admin origin.')
    origin = origin or file_origin
    token = token or file_token
    if not origin or not token:
      raise ShareError(f'Set ARTIFACTS_SHARE_URL and ARTIFACTS_SHARE_TOKEN, or provide url and token in {path}.')

  if not token.isascii() or any(not 33 <= ord(char) <= 126 for char in token):
    raise ShareError('Invalid Artifacts Share API token format.')
  return parse_origin(origin), token


class Client:
  def __init__(self):
    origin, token = connection_settings()
    self.base = origin + '/api/v1'
    # Cloudflare's Browser Integrity Check rejects urllib's default User-Agent with error 1010.
    self.headers = {
      'Authorization': f'Bearer {token}',
      'Accept': 'application/json',
      'User-Agent': 'artifacts-share-skill/1.0',
    }
    self.opener = build_opener(NoRedirect())

  def request(self, method, endpoint, *, data=None, file=None, size=None):
    headers = dict(self.headers)
    body = None
    if data is not None:
      body = json.dumps(data, ensure_ascii=False).encode()
      headers['Content-Type'] = 'application/json'
    elif file is not None:
      body = file
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Length'] = str(size)

    try:
      request = Request(self.base + endpoint, data=body, headers=headers, method=method)
      with self.opener.open(request, timeout=90) as response:
        payload = response.read()
    except HTTPError as error:
      with error:
        try:
          details = json.loads(error.read(32 * 1024)).get('error', {})
          reason = f"{details['code']}: {details['message']}"
        except (ValueError, KeyError, TypeError, AttributeError):
          reason = error.reason
      raise ShareError(f'{method} {endpoint.split("?")[0]} returned HTTP {error.code}: {reason}') from None
    except (URLError, OSError, HTTPException) as error:
      raise ShareError(f'{method} {endpoint.split("?")[0]} could not be confirmed: {error}') from None

    try:
      return json.loads(payload) if payload else None
    except ValueError:
      raise ShareError(f'{method} {endpoint.split("?")[0]} did not return JSON.') from None


def validate_path(path):
  parts = path.split('/')
  if (
    path != path.strip() or '\\' in path or len(path.encode('utf-16-le')) > 1024
    or any(ord(char) < 32 or ord(char) == 127 for char in path)
    or parts[0] == '__share' or any(part in ('', '.', '..') for part in parts)
  ):
    raise ShareError(f'Invalid artifact path: {path!r}')
  return path


def ignored(path):
  parts = path.split('/')
  return '__MACOSX' in parts or parts[-1] in ('.DS_Store', 'Thumbs.db')


def walk_folder(root, path=None):
  folder = root if path is None else path
  for child in sorted(folder.iterdir()):
    name = child.relative_to(root).as_posix()
    if ignored(name):
      continue
    if child.is_symlink():
      raise ShareError(f'Symbolic links are unsupported: {name!r}')
    if child.is_dir():
      yield from walk_folder(root, child)
    elif child.is_file():
      yield validate_path(name), child.stat().st_size, child.open
    else:
      raise ShareError(f'Expected a regular file: {name!r}')


@contextlib.contextmanager
def upload_files(source):
  if source.is_symlink():
    raise ShareError('Choose a regular file or directory.')
  if source.is_dir():
    yield list(walk_folder(source)), ''
  elif source.is_file() and source.suffix.lower() in ('.html', '.htm', '.md', '.markdown'):
    yield [(validate_path(source.name), source.stat().st_size, source.open)], ''
  elif source.is_file() and source.suffix.lower() == '.zip':
    with ZipFile(source) as archive:
      files = []
      for member in archive.infolist():
        name = member.orig_filename.replace('\\', '/')
        if name.endswith('/') or ignored(name):
          continue
        mode = stat.S_IFMT(member.external_attr >> 16)
        if mode not in (0, stat.S_IFREG) or member.flag_bits & 1:
          raise ShareError(f'ZIP entries must be unencrypted regular files: {name!r}')
        files.append((validate_path(name), member.file_size, member))
      root = files[0][0].partition('/')[0] + '/' if files else ''
      strip = root if root and all(name.startswith(root) for name, _, _ in files) else ''
      yield [
        (validate_path(name[len(strip):]), size, lambda _mode, member=member: archive.open(member))
        for name, size, member in files
      ], strip
  else:
    raise ShareError(f'Choose an HTML or Markdown file, a directory, or a ZIP: {source}')


def metadata(args):
  return {field: getattr(args, field) for field in METADATA if getattr(args, field) is not None}


def show_artifact(result, include_access_code=False):
  # The API also returns the access code to the owner on ordinary read and write requests.
  return {key: value for key, value in result.items() if key != 'password' or include_access_code}


def publish(args):
  meta = metadata(args)
  if args.artifact_id:
    meta['artifact_id'] = args.artifact_id
  else:
    meta.setdefault('visibility', 'private')

  if args.source.is_dir() or args.source.suffix.lower() == '.zip':
    meta['source_kind'] = 'folder'

  with upload_files(args.source) as (files, strip):
    names = [name for name, _, _ in files]
    if not names:
      raise ShareError('The source has no uploadable files.')
    if len(set(names)) != len(names):
      raise ShareError('The source contains duplicate artifact paths.')
    if 'entry' in meta:
      entry = meta['entry']
      if strip and entry.startswith(strip):
        entry = entry[len(strip):]
      if validate_path(entry) not in names:
        raise ShareError(f'Entry is missing from this upload: {entry!r}')
      meta['entry'] = entry

    if args.dry_run:
      return {**meta, 'file_count': len(files), 'total_size': sum(size for _, size, _ in files), 'files': names}
    client = Client()
    session = client.request('POST', '/uploads', data={**meta, 'files': names})
    endpoint = f"/uploads/{quote(session['upload_id'], safe='')}"
    try:
      for name, size, open_file in files:
        with open_file('rb') as file:
          client.request('PUT', f"{endpoint}/files/{quote(name, safe='/')}", file=file, size=size)
    except (ShareError, OSError, ValueError, BadZipFile, RuntimeError, KeyboardInterrupt):
      try:
        client.request('DELETE', endpoint)
      except ShareError as cleanup_error:
        print(f'Could not abort upload {session["upload_id"]}: {cleanup_error}', file=sys.stderr)
      raise

    try:
      result = client.request('POST', endpoint + '/commit')
    except ShareError as error:
      raise ShareError(
        f'{error}\nUpload ID {session["upload_id"]}, artifact ID {session["artifact_id"]}, version {session["version"]}. '
        'Check the artifact and its versions before attempting another publish.'
      ) from None
    return show_artifact(result, args.include_access_code)


def parse_artifact_id(value):
  try:
    parsed = UUID(value)
  except ValueError as error:
    raise argparse.ArgumentTypeError('expected the artifact UUID from the authenticated API') from error
  if str(parsed) != value.lower():
    raise argparse.ArgumentTypeError('expected a UUID in its hyphenated form')
  return str(parsed)


def add_metadata(parser):
  parser.add_argument('--title')
  parser.add_argument('--visibility', choices=VISIBILITIES)
  parser.add_argument('--entry')
  parser.add_argument('--spa-fallback', action=argparse.BooleanOptionalAction)
  parser.add_argument('--indexable', action=argparse.BooleanOptionalAction)


def configure():
  parser = argparse.ArgumentParser(description=__doc__)
  commands = parser.add_subparsers(dest='command', required=True)
  upload = commands.add_parser('publish', help='publish an HTML or Markdown file, directory, or ZIP')
  upload.add_argument('source', type=Path)
  upload.add_argument('--artifact-id', type=parse_artifact_id, help='publish a new version of this artifact')
  upload.add_argument('--dry-run', action='store_true', help='print the local file list without contacting the API')
  add_metadata(upload)
  listing = commands.add_parser('list', help='list or search artifacts')
  listing.add_argument('--query')
  listing.add_argument('--visibility', choices=VISIBILITIES)
  listing.add_argument('--cursor')
  listing.add_argument('--limit', type=int, choices=range(1, 101), metavar='1..100', default=50)

  detail = commands.add_parser('get', help='fetch artifact metadata')
  patch = commands.add_parser('patch', help='change artifact metadata')
  add_metadata(patch)
  versions = commands.add_parser('versions', help='list previously published versions')
  for command in (detail, patch, versions):
    command.add_argument('artifact_id', type=parse_artifact_id)
  for command in (upload, detail, patch):
    command.add_argument('--include-access-code', action='store_true', help='include the access code in JSON output')
  return parser.parse_args()


def execute(args):
  if args.command == 'publish':
    return publish(args)
  client = Client()
  if args.command == 'list':
    filters = {'q': args.query, 'visibility': args.visibility, 'cursor': args.cursor, 'limit': args.limit}
    return client.request('GET', '/artifacts?' + urlencode({key: val for key, val in filters.items() if val is not None}))
  path = f'/artifacts/{args.artifact_id}'
  if args.command == 'versions':
    return client.request('GET', path + '/versions')
  if args.command == 'patch':
    changes = metadata(args)
    if not changes:
      raise ShareError('Provide at least one metadata change.')
    result = client.request('PATCH', path, data=changes)
  else:
    result = client.request('GET', path)
  return show_artifact(result, args.include_access_code)


if __name__ == '__main__':
  try:
    print(json.dumps(execute(configure()), ensure_ascii=False, indent=2))
  except (ShareError, OSError, ValueError, BadZipFile, RuntimeError) as error:
    print(error, file=sys.stderr)
    sys.exit(1)
  except KeyboardInterrupt:
    print('Interrupted.', file=sys.stderr)
    sys.exit(130)
