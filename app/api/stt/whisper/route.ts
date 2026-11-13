/**
 * Whisper upload relay: the renderer POSTs one WAV here at Stop, and this
 * route forwards it to the configured self-hosted Whisper server.
 *
 * Why a relay (the streaming mode stays direct): speaches/faster-whisper-
 * server answers CORS preflights but omits Access-Control-Allow-Origin on
 * the actual response unless its own host is localhost — so a LAN server
 * (http://192.168.x.y:8000) can't be POSTed to from the app window. A
 * WebSocket isn't subject to CORS, so live streaming needs no relay.
 *
 * The target URL, model and language come from the saved dictation
 * settings, never from the request — this route can only reach the server
 * the user configured. Request: multipart with the WAV in `file`.
 * Response: { text } or { message } (the client shows it on the button).
 */
import { WHISPER_UPLOAD_TIMEOUT_MS, tidyWhisperText, whisperLanguage, whisperTranscriptionsUrl } from "@/src/core";
import { effectiveSettings } from "@/src/server";

export async function POST(request: Request) {
	const { whisper, language } = effectiveSettings().dictation;

	let audio: Blob;
	try {
		const file = (await request.formData()).get("file");
		if (!(file instanceof Blob) || file.size === 0) throw new Error();
		audio = file;
	} catch {
		return Response.json({ message: "Expected a WAV recording in the 'file' field" }, { status: 400 });
	}

	const body = new FormData();
	body.append("file", audio, "dictation.wav");
	body.append("model", whisper.model);
	const lang = whisperLanguage(language);
	if (lang) body.append("language", lang);
	body.append("response_format", "json");

	// The renderer's Esc aborts its request; carry that through to Whisper.
	const timeout = AbortSignal.timeout(WHISPER_UPLOAD_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(whisperTranscriptionsUrl(whisper.url), {
			method: "POST", body, signal: AbortSignal.any([request.signal, timeout]),
		});
	} catch {
		if (timeout.aborted) return Response.json({ message: "Whisper took too long to transcribe" }, { status: 504 });
		return Response.json({ message: `Whisper server unreachable (${whisper.url})` }, { status: 502 });
	}
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).trim().slice(0, 120);
		return Response.json(
			{ message: `Whisper transcription failed (${res.status})${detail ? `: ${detail}` : ""}` },
			{ status: 502 },
		);
	}
	const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
	if (typeof data?.text !== "string") {
		return Response.json({ message: "Whisper returned no transcript" }, { status: 502 });
	}
	return Response.json({ text: tidyWhisperText(data.text) });
}
