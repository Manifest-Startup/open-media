# open-media (Python)

The official Python client for the [Open Media](https://github.com/Manifest-Startup/open-media) API. No dependencies; Python 3.9+.

```bash
pip install open-media
```

```python
from open_media import OpenMedia

om = OpenMedia()
for post in om.feed(sources=["farcaster", "lens"], mode="raw")["data"]:
    print(post["network"], post["author"]["handle"], post["text"], post["url"])

results = om.search("videos about cooking today")
events = om.events(query="ai founders", days=7)
```

Acting for a person needs their own token (in the app: Settings, then Developers and agents):

```python
import os
me = OpenMedia(token=os.environ["OPEN_MEDIA_TOKEN"])
me.publish("Hello from my agent")
```

A web app that signed someone in with "Sign in with Open Media" (OAuth) passes `connected=True`; account calls then go to `/v1/connected/me/...` (ADR 0041). `start_conversation(handle, context)`, `messages`, `send_message(..., client_id)`, `upload_video`, `publish(..., video=, context=)`, `app_posts("manifest", kind="clips")`, `realtime_token()` and `verify_webhook(secret, headers, raw_body)` cover the app-integration routes.

Writes send an `Idempotency-Key` automatically, a 429 is retried after `Retry-After`, and errors raise `OpenMediaError` with `status`, `code` and `message`. Docs: https://api.openmedia.site/docs · MIT licence.
