import io
import json
import unittest
from urllib.error import HTTPError

import hashlib
import hmac

from open_media import OpenMedia, OpenMediaError, verify_webhook


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def opener(responses, seen):
    def open_(request, timeout):
        seen.append(request)
        status, body, headers = responses.pop(0)
        if status >= 400:
            raise HTTPError(request.full_url, status, "error", headers, io.BytesIO(json.dumps(body).encode()))
        return FakeResponse(json.dumps(body).encode())
    return open_


class ClientTest(unittest.TestCase):
    def test_public_feed_needs_no_token(self):
        seen = []
        om = OpenMedia(base_url="https://api.test/", opener=opener([(200, {"data": []}, {})], seen))
        om.feed(sources=["farcaster", "lens"], mode="raw")
        self.assertEqual(seen[0].full_url, "https://api.test/v1/feed?sources=farcaster%2Clens&mode=raw")
        self.assertIsNone(seen[0].get_header("Authorization"))

    def test_writes_keep_one_idempotency_key_across_a_retry(self):
        seen = []
        om = OpenMedia(base_url="https://api.test", token="tok", opener=opener([(429, {}, {"Retry-After": "0"}), (201, {"id": "p1"}, {})], seen))
        self.assertEqual(om.publish("hello"), {"id": "p1"})
        self.assertEqual(seen[0].get_header("Authorization"), "Bearer tok")
        self.assertEqual(seen[0].get_header("Idempotency-key"), seen[1].get_header("Idempotency-key"))

    def test_errors_keep_the_server_code(self):
        om = OpenMedia(base_url="https://api.test", opener=opener([(401, {"error": {"code": "unauthorized", "message": "Send your token."}}, {})], []))
        with self.assertRaises(OpenMediaError) as caught:
            om.me()
        self.assertEqual((caught.exception.status, caught.exception.code), (401, "unauthorized"))


if __name__ == "__main__":
    unittest.main()


class SignInTest(unittest.TestCase):
    def test_signing_in_with_a_code_makes_the_client_act_as_the_person(self):
        seen = []
        session = {"access_token": "at1", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "rt1", "user": {"id": "u1"}}
        om = OpenMedia(base_url="https://api.test", opener=opener([(200, {"sent": True}, {}), (200, session, {}), (200, {"handle": "ada"}, {})], seen))
        om.request_sign_in_code("ada@example.test")
        self.assertEqual(om.sign_in_with_code("ada@example.test", "12345678")["refresh_token"], "rt1")
        om.me()
        self.assertEqual(seen[1].full_url, "https://api.test/v1/auth/verify")
        self.assertEqual(seen[2].get_header("Authorization"), "Bearer at1")


class AppIntegrationTest(unittest.TestCase):
    def test_connected_apps_use_v1_connected_and_read_oauth_errors(self):
        seen = []
        om = OpenMedia(base_url="https://api.test", token="oauth", connected=True,
                       opener=opener([(200, {"conversations": []}, {}), (404, {"error": "not_found", "error_description": "Post not found."}, {})], seen))
        om.conversations(app="manifest")
        self.assertEqual(seen[0].full_url, "https://api.test/v1/connected/me/conversations?app=manifest")
        with self.assertRaises(OpenMediaError) as caught:
            om.delete_post("p1")
        self.assertEqual((caught.exception.code, caught.exception.message), ("not_found", "Post not found."))

    def test_video_upload_sends_the_raw_body_then_publishes_with_context(self):
        seen = []
        video = {"path": "u/v.mp4", "durationSeconds": 8}
        om = OpenMedia(base_url="https://api.test", token="tok", opener=opener([(201, {"video": video}, {}), (201, {"id": "p1"}, {})], seen))
        self.assertEqual(om.upload_video(b"\x00\x01", "video/mp4"), video)
        self.assertEqual(seen[0].data, b"\x00\x01")
        self.assertEqual(seen[0].get_header("Content-type"), "video/mp4")
        om.publish("", video=video, context={"app": "manifest", "idea_id": "42"})
        self.assertEqual(json.loads(seen[1].data), {"text": "", "video": video, "context": {"app": "manifest", "idea_id": "42"}})

    def test_webhook_signatures_are_checked_within_five_minutes(self):
        secret, body, ts = "s" * 32, b'{"id":"d1"}', "1800000000"
        signature = "sha256=" + hmac.new(secret.encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()
        headers = {"X-Open-Media-Timestamp": ts, "X-Open-Media-Signature": signature}
        self.assertTrue(verify_webhook(secret, headers, body, now=1800000100))
        self.assertFalse(verify_webhook(secret, headers, body, now=1800000400))
        self.assertFalse(verify_webhook("w" * 32, headers, body, now=1800000000))
        self.assertFalse(verify_webhook(secret, headers, body + b" ", now=1800000000))
