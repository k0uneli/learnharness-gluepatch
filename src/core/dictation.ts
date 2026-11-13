/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}

/* ── Self-hosted Whisper engine ─────────────────────────────────────────
 * An OpenAI-compatible Whisper server (speaches / faster-whisper-server).
 * The window talks to it directly — no app-server hop, no token. Two
 * transports, user-selectable:
 *   - upload: the run's PCM is kept locally and POSTed once as a WAV when
 *     the run stops — relayed by the app server (/api/stt/whisper), because
 *     speaches omits CORS headers on real responses to non-localhost hosts.
 *   - stream: PCM frames go over ws(s)://…/v1/audio/transcriptions; each
 *     message carries the WHOLE transcript so far ({"text": "…"}), and the
 *     server closes (1000) shortly after audio stops arriving.
 */

export const DICTATION_ENGINES = ["deepgram", "whisper"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

export const WHISPER_MODES = ["upload", "stream"] as const;
export type WhisperMode = (typeof WHISPER_MODES)[number];

/** Stored delta (absent field = factory default). */
export interface WhisperSettings {
	url?: string;
	model?: string;
	mode?: WhisperMode;
}

export const WHISPER_DEFAULTS: Required<WhisperSettings> = {
	url: "http://localhost:8000",
	model: "Systran/faster-whisper-large-v3",
	mode: "upload",
};

export const WHISPER_MODEL_MAX_LENGTH = 200;

/** Upload mode: backstop for a server that never answers (Esc cancels
 *  sooner). Long recordings on a slow model can legitimately take a while. */
export const WHISPER_UPLOAD_TIMEOUT_MS = 120_000;

export function isDictationEngine(value: unknown): value is DictationEngine {
	return DICTATION_ENGINES.includes(value as DictationEngine);
}

export function isWhisperMode(value: unknown): value is WhisperMode {
	return WHISPER_MODES.includes(value as WhisperMode);
}

/** A model id: non-empty, no whitespace, bounded. */
export function isWhisperModel(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= WHISPER_MODEL_MAX_LENGTH && !/\s/.test(value);
}

/** The server's base URL: http(s) only, no credentials/query/hash; a
 *  trailing "/" or "/v1" (or a pasted endpoint path) is stripped so the
 *  stored value is the bare base. null = not a usable URL. */
export function normalizeWhisperUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	const path = url.pathname.replace(/\/+$/, "").replace(/\/v1(\/audio\/transcriptions)?$/, "").replace(/\/+$/, "");
	return url.origin + path;
}

/** Whisper takes ISO-639-1 base codes: locale aliases collapse to their
 *  language (en-US → en, zh-TW → zh); Multilingual sends no language so
 *  Whisper auto-detects. */
export function whisperLanguage(language: DictationLanguage): string | undefined {
	return language === "multi" ? undefined : language.split("-")[0];
}

/** The upload endpoint (POST multipart). */
export function whisperTranscriptionsUrl(baseUrl: string): string {
	return `${baseUrl}/v1/audio/transcriptions`;
}

/** The streaming endpoint: same path, ws(s) scheme, params in the query. */
export function whisperStreamUrl(baseUrl: string, model: string, language: DictationLanguage): string {
	const url = new URL(whisperTranscriptionsUrl(baseUrl));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("model", model);
	const lang = whisperLanguage(language);
	if (lang) url.searchParams.set("language", lang);
	url.searchParams.set("response_format", "json");
	return url.toString();
}

/** Whisper's streamed text separates words with doubled spaces. */
export function tidyWhisperText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Wrap linear16 mono frames in a WAV container for the upload. */
export function pcm16ToWav(frames: readonly (ArrayBuffer | ArrayBufferView)[], sampleRate = 16000): ArrayBuffer {
	const dataBytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
	const wav = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(wav);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	const bytes = new Uint8Array(wav);
	let offset = 44;
	for (const frame of frames) {
		bytes.set(ArrayBuffer.isView(frame) ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : new Uint8Array(frame), offset);
		offset += frame.byteLength;
	}
	return wav;
}
