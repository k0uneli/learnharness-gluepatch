import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	DICTATION_LANGUAGES, WHISPER_DEFAULTS, normalizeWhisperUrl, pcm16ToWav, tidyWhisperText,
	whisperLanguage, whisperStreamUrl, whisperTranscriptionsUrl,
} from "../src/core/dictation.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

describe("self-hosted Whisper dictation contract", () => {
	it("maps every picker language to a Whisper base code; Multilingual auto-detects", () => {
		assert.equal(whisperLanguage("multi"), undefined);
		assert.equal(whisperLanguage("en"), "en");
		assert.equal(whisperLanguage("en-GB"), "en");
		assert.equal(whisperLanguage("zh-Hant"), "zh");
		assert.equal(whisperLanguage("es-419"), "es");
		assert.equal(whisperLanguage("ar-EG"), "ar");
		for (const { code } of DICTATION_LANGUAGES) {
			if (code === "multi") continue;
			assert.match(whisperLanguage(code)!, /^[a-z]{2}$/, code);
		}
	});

	it("normalizes the server URL to its bare base and refuses non-http values", () => {
		for (const [raw, base] of [
			["http://192.168.1.24:8000", "http://192.168.1.24:8000"],
			[" http://192.168.1.24:8000/ ", "http://192.168.1.24:8000"],
			["http://192.168.1.24:8000/v1", "http://192.168.1.24:8000"],
			["http://192.168.1.24:8000/v1/", "http://192.168.1.24:8000"],
			["http://192.168.1.24:8000/v1/audio/transcriptions", "http://192.168.1.24:8000"],
			["https://whisper.example/proxy/v1", "https://whisper.example/proxy"],
		] as const) {
			assert.equal(normalizeWhisperUrl(raw), base, raw);
		}
		for (const bad of ["", "192.168.1.24:8000", "ftp://host", "ws://host:8000", "http://u:p@host", "http://host?x=1", "http://host#a", null, 3]) {
			assert.equal(normalizeWhisperUrl(bad), null, String(bad));
		}
	});

	it("builds the upload and streaming endpoints the server expects", () => {
		assert.equal(whisperTranscriptionsUrl("http://192.168.1.24:8000"), "http://192.168.1.24:8000/v1/audio/transcriptions");
		const ws = new URL(whisperStreamUrl("http://192.168.1.24:8000", "Systran/faster-whisper-large-v3", "en-GB"));
		assert.equal(ws.origin + ws.pathname, "ws://192.168.1.24:8000/v1/audio/transcriptions");
		assert.deepEqual(Object.fromEntries(ws.searchParams), {
			model: "Systran/faster-whisper-large-v3", language: "en", response_format: "json",
		});
		const auto = new URL(whisperStreamUrl("https://host", "m", "multi"));
		assert.equal(auto.protocol, "wss:");
		assert.equal(auto.searchParams.has("language"), false, "multilingual auto-detects");
	});

	it("collapses the streamed double spaces", () => {
		assert.equal(tidyWhisperText("The  mitochondria  is  the  powerhouse. "), "The mitochondria is the powerhouse.");
	});

	it("wraps linear16 frames (ArrayBuffers or Int16Array views) in a 16kHz mono WAV", () => {
		const a = new Int16Array([1, -2]);
		const b = new Int16Array([3, 4, 5]).subarray(1); // a view with an offset
		const wav = new DataView(pcm16ToWav([a, b.slice().buffer, b]));
		const ascii = (offset: number) => String.fromCharCode(...new Uint8Array(wav.buffer, offset, 4));
		assert.equal(ascii(0), "RIFF");
		assert.equal(ascii(8), "WAVE");
		assert.equal(wav.getUint16(22, true), 1, "mono");
		assert.equal(wav.getUint32(24, true), 16000);
		assert.equal(wav.getUint16(34, true), 16);
		assert.equal(wav.getUint32(40, true), 12);
		assert.equal(wav.getUint32(4, true), 36 + 12);
		const samples = Array.from({ length: 6 }, (_, i) => wav.getInt16(44 + i * 2, true));
		assert.deepEqual(samples, [1, -2, 4, 5, 4, 5]);
	});

	it("defaults to Deepgram with generic Whisper defaults; old records keep working", () => {
		assert.deepEqual(FACTORY_SETTINGS.dictation, {
			language: "en", engine: "deepgram",
			whisper: { url: "http://localhost:8000", model: "Systran/faster-whisper-large-v3", mode: "upload" },
		});
		assert.deepEqual(WHISPER_DEFAULTS, FACTORY_SETTINGS.dictation.whisper);
		assert.deepEqual(resolveSettings(sanitizeUserSettings({ version: 1, dictation: { language: "pl" } })).dictation, {
			language: "pl", engine: "deepgram", whisper: WHISPER_DEFAULTS,
		});
		assert.deepEqual(resolveSettings(sanitizeUserSettings({
			version: 1, dictation: { engine: "whisper", whisper: { url: "http://192.168.1.24:8000", mode: "stream" } },
		})).dictation, {
			language: "en", engine: "whisper",
			whisper: { url: "http://192.168.1.24:8000", model: WHISPER_DEFAULTS.model, mode: "stream" },
		});
	});

	it("the read side drops only the invalid field; the write side refuses it", () => {
		const record = sanitizeUserSettings({
			version: 1,
			dictation: { language: "xx", engine: "whisper", whisper: { url: "ftp://x", model: "has space", mode: "stream" } },
		});
		assert.deepEqual(record?.dictation, { engine: "whisper", whisper: { mode: "stream" } });
		assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { engine: "nope", whisper: [] } })?.dictation, {});

		assert.deepEqual(parseDictationSettingsBody({
			language: "pl", engine: "whisper",
			whisper: { url: "http://192.168.1.24:8000/v1/", model: "Systran/faster-whisper-large-v3", mode: "stream" },
		}), {
			ok: true,
			settings: {
				language: "pl", engine: "whisper",
				whisper: { url: "http://192.168.1.24:8000", model: "Systran/faster-whisper-large-v3", mode: "stream" },
			},
		});
		assert.deepEqual(parseDictationSettingsBody({ engine: "whisper", whisper: {} }), { ok: true, settings: { engine: "whisper", whisper: {} } });
		for (const body of [
			{ engine: "openai" },
			{ engine: null },
			{ whisper: "http://host" },
			{ whisper: { url: "nope" } },
			{ whisper: { url: "ws://host" } },
			{ whisper: { model: "" } },
			{ whisper: { model: "a b" } },
			{ whisper: { model: "x".repeat(201) } },
			{ whisper: { mode: "batch" } },
		]) {
			assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
		}
	});
});

const testData = mkdtempSync(path.join(tmpdir(), "lh-dictation-whisper-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

it("the section route stores the Whisper config normalized and refuses a bad URL without writing", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1, general: { autoUpdate: false } });
	const put = (body: unknown) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "dictation" }) });
	const ok = await put({ language: "en", engine: "whisper", whisper: { url: "http://192.168.1.24:8000/", mode: "stream" } });
	assert.equal(ok.status, 200);
	const saved = {
		version: 1, general: { autoUpdate: false },
		dictation: { language: "en", engine: "whisper", whisper: { url: "http://192.168.1.24:8000", mode: "stream" } },
	};
	assert.deepEqual(readSettings(), saved);
	assert.deepEqual((await ok.json()).settings.dictation, saved.dictation, "the response confirms the normalized value");
	const bad = await put({ engine: "whisper", whisper: { url: "192.168.1.24" } });
	assert.equal(bad.status, 400);
	assert.match((await bad.json()).error, /http\(s\) URL/);
	assert.deepEqual(readSettings(), saved);
});

describe("the Whisper upload relay (/api/stt/whisper)", async () => {
	const { createServer } = await import("node:http");
	const received: { path: string; fields: Record<string, string>; fileBytes: number }[] = [];
	let reply: { status: number; body: string } = { status: 200, body: JSON.stringify({ text: "  Hello  world. " }) };
	const fake = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(chunks) }).formData();
		const fields: Record<string, string> = {};
		let fileBytes = 0;
		for (const [k, v] of form) {
			if (typeof v === "string") fields[k] = v;
			else fileBytes = v.size;
		}
		received.push({ path: req.url!, fields, fileBytes });
		res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
	});
	await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
	after(() => fake.close());
	const base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
	const { POST } = await import("../app/api/stt/whisper/route.ts");
	const upload = (file: Blob | null = new Blob([pcm16ToWav([new Int16Array([1, 2, 3])])], { type: "audio/wav" })) => {
		const form = new FormData();
		if (file) form.append("file", file, "dictation.wav");
		return POST(new Request("http://localhost/api/stt/whisper", { method: "POST", body: form }));
	};
	const configure = (language: string, url = base) => writeSettings({
		version: 1, dictation: { language, engine: "whisper", whisper: { url, model: "Systran/faster-whisper-large-v3" } },
	} as never);

	it("forwards the WAV with the saved model and mapped language; returns tidied text", async () => {
		configure("en-GB");
		const res = await upload();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { text: "Hello world." });
		assert.deepEqual(received.at(-1), {
			path: "/v1/audio/transcriptions",
			fields: { model: "Systran/faster-whisper-large-v3", language: "en", response_format: "json" },
			fileBytes: 44 + 6,
		});
	});

	it("Multilingual omits the language so Whisper auto-detects", async () => {
		configure("multi");
		assert.equal((await upload()).status, 200);
		assert.equal("language" in received.at(-1)!.fields, false);
	});

	it("reports server failures, an unreachable server, and a missing recording", async () => {
		configure("en");
		reply = { status: 500, body: "Internal Server Error" };
		let res = await upload();
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { message: "Whisper transcription failed (500): Internal Server Error" });
		reply = { status: 200, body: "{}" };
		res = await upload();
		assert.deepEqual(await res.json(), { message: "Whisper returned no transcript" });

		configure("en", "http://127.0.0.1:1");
		res = await upload();
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { message: "Whisper server unreachable (http://127.0.0.1:1)" });

		const before = received.length;
		res = await upload(null);
		assert.equal(res.status, 400);
		assert.equal(received.length, before, "nothing forwarded");
	});
});
