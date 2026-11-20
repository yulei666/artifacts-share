# Artifacts Share API

Authenticated requests go to `<admin-origin>/api/v1` with `Authorization: Bearer <token>`. Use `Content-Type: application/json` for JSON bodies. The response field `id` identifies the artifact for management calls. `public_id` is the ID used by the viewer and can change. Share the `url` from the response. `content_url` is the isolated content subdomain.

## Publishing and lookup

| Method and path | Use |
| --- | --- |
| `GET /artifacts` | List or search. Optional `q`, `visibility`, `limit` (1–100), and `cursor`. Returns `items` and `next_cursor`. |
| `GET /artifacts/{id}` | Read live metadata and the current access code for a password-protected artifact. |
| `PATCH /artifacts/{id}` | Update selected fields from `title`, `visibility`, `entry`, `spa_fallback`, and `indexable`. |
| `POST /uploads` | Start a session with `files` as an array of relative file paths, optional metadata, and optional `artifact_id` for an update. Send `source_kind: "folder"` for directory or archive inputs, including single-file folders. |
| `PUT /uploads/{upload_id}/files/{path}` | Send file bytes with a known length. Percent-encode each path segment and preserve directory separators. |
| `POST /uploads/{upload_id}/commit` | Publish after all writes finish. Returns the artifact on success. |
| `DELETE /uploads/{upload_id}` | Abort an unfinished session. |

An upload session expires after 24 hours. The helper reads ZIP entries locally and uses one upload session, so server-side ZIP extraction can stay disabled. The server also accepts one-shot `POST /artifacts` and `PUT /artifacts/{id}/content` with raw HTML or Markdown, multipart files, or a ZIP when server-side extraction is enabled. Upload limits come from server settings.

## Versions, links, and files

| Method and path | Effect |
| --- | --- |
| `GET /artifacts/{id}/versions` | List available versions and the current version. |
| `POST /artifacts/{id}/versions/{version}/activate` | Make a retained version live. |
| `POST /artifacts/{id}/password/reset` | Issue a new access code for an artifact in password mode. |
| `POST /artifacts/{id}/regenerate-link` | Replace the public ID and invalidate the old link. Pass `{"reset_password":true}` to rotate the access code too. |
| `GET /artifacts/{id}/files` | List files. Use `?version=N` to select a version. |
| `GET /artifacts/{id}/files/{path}` | Download an individual file as an attachment. Accepts `?version=N`. |
| `DELETE /artifacts/{id}` | Remove the artifact, its versions, and files. |

Perform writes, version activation, link regeneration, or deletion only when the user requests that effect. The share-page download endpoint uses owner session authentication or visitor access rules. For Bearer-authenticated automation, use the file endpoints above.

## Failures

- `401 invalid_token` usually means the token is missing, revoked, or for a different instance.
- `400 missing_files` or `invalid_entry` means review the manifest and chosen entry.
- `413` indicates a file or version limit. Report the API's error so the user can adjust the upload.
- `409 superseded` means the version was stored while a newer version remained live. Read `GET /artifacts/{id}/versions` before deciding whether to activate or upload again.
- `400 invalid_path` means a path was rejected. A leading `./` or `/` is removed and `\` counts as `/`; the rest must be non-empty and at most 512 characters, with no empty, `.` or `..` segment (`a//b`, `a/./b` and `x/../y` are rejected), no control characters, no reserved `__share/` prefix, and well-formed Unicode. If `POST /uploads` rejected a path in its `files` list, no session was created: rename the file and start again. If a file `PUT` was rejected, the session is still usable: send that file under a valid name.

Upload-session errors decide whether to retry, restart, or stop:

- `409 upload_busy` (commit) usually clears quickly: file writes are still finishing. Retry `POST /uploads/{upload_id}/commit` with the same upload ID a few times with increasing waits (for example 1, 2, 4, 8 seconds). If it persists, abort with `DELETE /uploads/{upload_id}` and start a new upload.
- `409 upload_closed` (commit, file `PUT` or `DELETE` of the session) means the session was already committed, typically by an earlier attempt whose response was lost. Do not upload again, and treat it as success for cleanup purposes. Read `GET /artifacts/{id}` and its versions to confirm what is live.
- `409 manifest_lost` means the declared file list of this session is incomplete, so it can never be committed. Abort it with `DELETE /uploads/{upload_id}` and start a new upload.
- `404 upload_not_found` means the session is gone: it was aborted, it expired after 24 hours, or its artifact was deleted. If the user still wants to publish, start a new upload. If a commit for this session had already been sent (its response lost), first check `GET /artifacts/{id}/versions`: a session committed shortly before a server upgrade can still answer 404.
