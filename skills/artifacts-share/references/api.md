# Artifacts Share API

Authenticated requests go to `<admin-origin>/api/v1` with `Authorization: Bearer <token>`. Use `Content-Type: application/json` for JSON bodies. The response field `id` identifies the artifact for management calls. `public_id` is the ID used by the viewer and can change. Share the `url` from the response. `content_url` is the isolated content subdomain.

## Publishing and lookup

| Method and path | Use |
| --- | --- |
| `GET /artifacts` | List or search. Optional `q`, `visibility`, `limit` (1–100), and `cursor`. Returns `items` and `next_cursor`. |
| `GET /artifacts/{id}` | Read live metadata and the current access code for a password-protected artifact. |
| `PATCH /artifacts/{id}` | Update selected fields from `title`, `visibility`, `entry`, `spa_fallback`, and `indexable`. |
| `POST /uploads` | Start a session with `files` as an array of relative file paths, optional metadata, and optional `artifact_id` for an update. |
| `PUT /uploads/{upload_id}/files/{path}` | Send file bytes with a known length. Percent-encode each path segment and preserve directory separators. |
| `POST /uploads/{upload_id}/commit` | Publish after all writes finish. Returns the artifact on success. |
| `DELETE /uploads/{upload_id}` | Abort an unfinished session. |

An upload session expires after 24 hours. The helper reads ZIP entries locally and uses one upload session, so server-side ZIP extraction can stay disabled. The server also accepts one-shot `POST /artifacts` and `PUT /artifacts/{id}/content` with raw HTML, multipart files, or a ZIP when server-side extraction is enabled. Upload limits come from server settings.

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
