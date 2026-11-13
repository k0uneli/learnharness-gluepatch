import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import { isDictationActive, useDictationActive } from "../components/dictation-state.ts";
import type { UserSettings } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	get language() { return new URL(this.url).searchParams.get("language"); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	end(code = 1000) { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code })); }
	/** A Whisper stream message: the whole transcript so far. */
	text(text: string) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ text }) })); }
	final(text: string) {
		this.dispatchEvent(Object.assign(new Event("message"), {
			data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }),
		}));
	}
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static last: Worklet | undefined;
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {}
	disconnect() {}
	/** Feed one captured frame, as the pcm-capture worklet would. */
	static frame(samples: number[]) { Worklet.last!.port.onmessage!({ data: { type: "audio", buffer: new Int16Array(samples) } }); }
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(language: "pl" | "en" = "pl", delayedRead?: Promise<Response>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation: { language } } as UserSettings,
		nextRead: delayedRead,
		nextWrite: undefined as Promise<Response> | undefined,
		nextMic: undefined as Promise<{ getTracks: () => { stop: () => void }[] }> | undefined,
		readFails: false,
		reads: 0,
		active: false,
		captures: 0,
		stops: 0,
		appends: [] as string[],
		mints: 0,
		uploads: [] as { url: string; body: FormData; signal: AbortSignal }[],
		/** The Whisper relay's next reply (a deferred lets a test hold it). */
		nextUpload: undefined as Promise<Response> | undefined,
	};
	Socket.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			if (state.nextMic) return state.nextMic;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") { state.mints++; return Response.json({ token: "test-token" }); }
			if (url === "/api/stt/whisper") {
				state.uploads.push({ url, body: init!.body as FormData, signal: init!.signal! });
				const reply = state.nextUpload ?? Promise.resolve(Response.json({ text: "Hello world." }));
				state.nextUpload = undefined;
				return reply;
			}
			if (url === "/api/settings") {
				state.reads++;
				if (state.nextRead) { const response = state.nextRead; state.nextRead = undefined; return response; }
				return state.readFails ? Response.json({}, { status: 500 }) : Response.json({ settings: state.record });
			}
			assert.equal(url, "/api/settings/dictation");
			assert.equal(init?.method, "PUT");
			if (state.nextWrite) { const response = state.nextWrite; state.nextWrite = undefined; return response; }
			state.record = { ...state.record, dictation: JSON.parse(init.body as string) };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	let setting!: ReturnType<typeof useDictationLanguage>;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		setting = useDictationLanguage();
		state.active = useDictationActive();
		return null;
	}
	let root = createRoot(document.getElementById("root")!);
	let firstMount = true;
	const mount = async () => {
		await act(async () => { root.render(<Harness />); });
		// Each fixture is a new server record. Explicitly invalidate a prior
		// fixture's window-lifetime cache, but do not refetch on remounts.
		if (firstMount && setting.language !== undefined) {
			await act(async () => { notifySettingsSaved("dictation"); });
		}
		firstMount = false;
	};
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		get dictation() { return latest; },
		get setting() { return setting; },
		mount,
		unmount: () => dispose!(),
		remount: async () => {
			await dispose!();
			root = createRoot(document.getElementById("root")!);
			await mount();
		},
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("waits for the saved language; reconnect preserves it and finals still flush exactly once", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "connecting");
	assert.equal(f.state.active, true, "the settings row locks while connecting");
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0, "must not open a default-English socket before settings arrive");
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	const first = Socket.all[0]!;
	assert.equal(first.language, "pl");
	await act(async () => { first.open(); first.final("Cześć"); });
	assert.deepEqual(f.state.appends, []);
	// A preference refresh during capture affects the next run only.
	f.state.record.dictation = { language: "multi" };
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { first.end(1006); });
	const second = Socket.all[1]!;
	assert.equal(second.language, "pl");
	assert.deepEqual(second.protocols, ["bearer", "test-token"]);
	await act(async () => { second.open(); second.final("świecie"); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(f.state.active, true, "the settings row remains locked while stopping");
	assert.equal(second.sent.at(-1), JSON.stringify({ type: "CloseStream" }));
	await act(async () => { second.end(); });
	assert.deepEqual(f.state.appends, ["Cześć świecie"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.active, false);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[2]!.language, "multi");
});

test("a failed save keeps the previous language, including a shortcut pressed while saving", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let saved!: Promise<boolean>;
	await act(async () => { saved = f.setting.save("multi"); });
	assert.equal(f.setting.saving, true);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	await act(async () => { write.resolve(Response.json({}, { status: 500 })); await saved; });
	assert.equal(await saved, false);
	assert.equal(f.setting.language, "pl");
	assert.match(f.setting.error!, /Could not save/);
	assert.equal(Socket.all[0]!.language, "pl");
});

test("confirmed choices stay cached across navigation; failed explicit refreshes block capture", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { assert.equal(await f.setting.save("multi"), true); });
	const reads = f.state.reads;
	f.state.readFails = true;
	await f.remount();
	assert.equal(f.setting.language, "multi");
	assert.equal(f.state.reads, reads, "navigation must not reread a confirmed preference");
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	assert.match(f.dictation.error!, /Could not load/);
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	f.state.readFails = false;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a shortcut waits for a language save made by the separate settings control", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let saved!: Promise<boolean>;
	await act(async () => { saved = f.setting.save("multi"); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	f.state.record.dictation = { language: "multi" };
	await act(async () => { write.resolve(Response.json({ settings: f.state.record })); await saved; });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a saved-language refresh gates capture even when an older choice is cached", async () => {
	const f = await fixture();
	await f.mount();
	const read = deferred<Response>();
	f.state.nextRead = read.promise;
	f.state.record.dictation = { language: "multi" };
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("a stale settings refresh cannot overwrite a newer confirmed choice", async () => {
	const f = await fixture();
	await f.mount();
	const read = deferred<Response>();
	f.state.nextRead = read.promise;
	await act(async () => { notifySettingsSaved("dictation"); });
	await act(async () => { await f.setting.save("multi"); });
	await act(async () => { read.resolve(Response.json({ settings: { version: 1, dictation: { language: "pl" } } })); });
	assert.equal(f.setting.language, "multi");
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("cancel while settings load does not open a microphone or socket later", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.dictation.cancel(); });
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
});

test("reopening settings during a save shares its busy state and rejects a competing selection", async () => {
	const f = await fixture();
	await f.mount();
	const write = deferred<Response>();
	f.state.nextWrite = write.promise;
	let first!: Promise<boolean>;
	await act(async () => { first = f.setting.save("multi"); });
	await f.remount();
	assert.equal(f.setting.saving, true);
	assert.equal(await f.setting.save("en"), false, "a different selection cannot inherit another write's success");
	f.state.record.dictation = { language: "multi" };
	await act(async () => { write.resolve(Response.json({ settings: f.state.record })); await first; });
	assert.equal(f.setting.saving, false);
	assert.equal(f.setting.language, "multi");
});

test("a confirmed save applies to capture even when subsequent settings GET requests would fail", async () => {
	const f = await fixture();
	await f.mount();
	f.state.readFails = true;
	await act(async () => { assert.equal(await f.setting.save("multi"), true); });
	assert.equal(f.state.record.dictation?.language, "multi");
	await act(async () => { f.dictation.toggle(); });
	assert.equal(Socket.all[0]!.language, "multi");
});

test("unmount during a pending language read prevents orphaned capture", async () => {
	const read = deferred<Response>();
	const f = await fixture("pl", read.promise);
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	await f.unmount();
	await act(async () => { read.resolve(Response.json({ settings: f.state.record })); });
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
	assert.equal(isDictationActive(), false);
});

test("unmount during recording stops resources and discards the departing page's buffered text", async () => {
	const f = await fixture();
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("do not append into another page"); });
	await f.unmount();
	assert.equal(f.state.stops, 1);
	assert.equal(socket.readyState, 3);
	assert.equal(isDictationActive(), false);
	assert.deepEqual(f.state.appends, []);
	await act(async () => { socket.final("late event"); socket.end(1006); });
	assert.equal(Socket.all.length, 1);
	assert.deepEqual(f.state.appends, []);
});

test("microphone permission resolving after unmount immediately stops the late stream", async () => {
	const f = await fixture();
	await f.mount();
	const mic = deferred<{ getTracks: () => { stop: () => void }[] }>();
	f.state.nextMic = mic.promise;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.captures, 1);
	await f.unmount();
	await act(async () => { mic.resolve({ getTracks: () => [{ stop() { f.state.stops++; } }] }); });
	assert.equal(f.state.stops, 1);
	assert.equal(Socket.all.length, 0);
	assert.equal(isDictationActive(), false);
});

/* ── Self-hosted Whisper engine ── */

async function whisperFixture(mode: "upload" | "stream", language: "en-GB" | "multi" = "en-GB") {
	const f = await fixture();
	f.state.record = {
		version: 1,
		dictation: { language, engine: "whisper", whisper: { url: "http://whisper.test:8000", model: "Systran/faster-whisper-large-v3", mode } },
	};
	await f.mount();
	return f;
}

test("whisper upload: no token or socket; Stop posts one WAV to the app's relay and the text flushes once", async () => {
	const f = await whisperFixture("upload");
	const mintsAtMount = f.state.mints;
	const reply = deferred<Response>();
	f.state.nextUpload = reply.promise;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording", "nothing to connect: recording once the mic is live");
	await act(async () => { Worklet.frame([1, 2]); Worklet.frame([3]); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping", "spinner while the server transcribes");
	assert.equal(f.state.stops, 1, "the mic dies at Stop");
	assert.equal(f.state.uploads.length, 1);
	const { url, body } = f.state.uploads[0]!;
	assert.equal(url, "/api/stt/whisper", "relayed: speaches omits CORS headers for LAN hosts");
	assert.deepEqual([...body.keys()], ["file"], "the relay takes url/model/language from saved settings");
	const wav = new DataView(await (body.get("file") as Blob).arrayBuffer());
	assert.equal(wav.byteLength, 44 + 6);
	assert.deepEqual([0, 1, 2].map((i) => wav.getInt16(44 + i * 2, true)), [1, 2, 3]);
	assert.deepEqual(f.state.appends, []);
	await act(async () => { reply.resolve(Response.json({ text: "Hello world." })); });
	assert.deepEqual(f.state.appends, ["Hello world."]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.active, false);
	assert.equal(Socket.all.length, 0);
	assert.equal(f.state.mints, mintsAtMount, "Whisper never mints a Deepgram token");
});

test("whisper upload: finish() resolves after the text lands", async () => {
	const f = await whisperFixture("upload");
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.frame([7]); });
	let finished = false;
	await act(async () => { await f.dictation.finish().then(() => { finished = true; }); });
	assert.equal(finished, true);
	assert.deepEqual(f.state.appends, ["Hello world."]);
});

test("whisper upload: the relay's failure message surfaces on the button; nothing reaches the input", async () => {
	const f = await whisperFixture("upload");
	f.state.nextUpload = Promise.resolve(Response.json({ message: "Whisper transcription failed (500): model not found" }, { status: 502 }));
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.frame([1]); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.error, "Whisper transcription failed (500): model not found");
	assert.equal(f.dictation.phase, "idle");
	const unreachable = Promise.reject(new TypeError("fetch failed"));
	unreachable.catch(() => {}); // the hook awaits it later
	f.state.nextUpload = unreachable;
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.error, null, "the next run clears the error");
	await act(async () => { Worklet.frame([1]); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.error, "Whisper upload failed");
	assert.deepEqual(f.state.appends, []);
});

test("whisper upload: Esc while transcribing aborts the request and discards a late reply", async () => {
	const f = await whisperFixture("upload");
	const reply = deferred<Response>();
	f.state.nextUpload = reply.promise;
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.frame([1]); });
	await act(async () => { f.dictation.stop(); });
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.uploads[0]!.signal.aborted, true);
	assert.equal(f.dictation.phase, "idle");
	await act(async () => { reply.resolve(Response.json({ text: "too late" })); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.error, null);
});

test("whisper upload: stopping before any audio uploads nothing", async () => {
	const f = await whisperFixture("upload");
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.state.uploads.length, 0);
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, []);
});

test("whisper stream: queued frames flush on open, the latest whole transcript wins, Stop waits for the server's close", async () => {
	const f = await whisperFixture("stream");
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	const url = new URL(socket.url);
	assert.equal(url.origin + url.pathname, "ws://whisper.test:8000/v1/audio/transcriptions");
	assert.deepEqual(Object.fromEntries(url.searchParams), { model: "Systran/faster-whisper-large-v3", language: "en", response_format: "json" });
	assert.deepEqual(socket.protocols, undefined, "no auth subprotocol");
	await act(async () => { Worklet.frame([1]); });
	assert.equal(socket.sent.length, 0, "queued until open");
	await act(async () => { socket.open(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(socket.sent.length, 1);
	await act(async () => { Worklet.frame([2]); socket.text("The  mitochondria"); socket.text("The  mitochondria  is  the  powerhouse."); });
	assert.equal(socket.sent.length, 2);
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(socket.sent.length, 2, "no CloseStream: the server closes once audio stops");
	assert.deepEqual(f.state.appends, []);
	await act(async () => { socket.text("The  mitochondria  is  the  powerhouse  of  the  cell."); socket.end(1000); });
	assert.deepEqual(f.state.appends, ["The mitochondria is the powerhouse of the cell."]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(Socket.all.length, 1);
});

test("whisper stream: a mid-run drop keeps its text and the one reconnect appends after it", async () => {
	const f = await whisperFixture("stream");
	await act(async () => { f.dictation.toggle(); });
	const first = Socket.all[0]!;
	await act(async () => { first.open(); first.text("first  part"); first.end(1006); });
	const second = Socket.all[1]!;
	assert.ok(second, "reconnects once");
	await act(async () => { second.open(); second.text("second  part"); });
	await act(async () => { f.dictation.stop(); });
	await act(async () => { second.end(1000); });
	assert.deepEqual(f.state.appends, ["first part second part"]);
});

test("whisper stream: an unreachable server reports its URL after the one retry", async () => {
	const f = await whisperFixture("stream");
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Socket.all[0]!.end(1006); });
	await act(async () => { Socket.all[1]!.end(1006); });
	assert.equal(Socket.all.length, 2);
	assert.equal(f.dictation.error, "Whisper server unreachable (http://whisper.test:8000)");
	assert.equal(f.dictation.phase, "idle");
});

test("whisper stream: Esc discards the streamed text", async () => {
	const f = await whisperFixture("stream");
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.text("discard  me"); });
	await act(async () => { f.dictation.cancel(); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(socket.readyState, 3);
});
