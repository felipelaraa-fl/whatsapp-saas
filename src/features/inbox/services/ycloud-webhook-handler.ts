import { createHmac, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inboundContentText } from "./inbound-content";
import type { OutboundEcho } from "./kapso-webhook-handler";

/**
 * Verifies a YCloud webhook signature.
 *
 * Header format: "t={unixSeconds},s={hmacSha256Hex}"
 * Signed material: HMAC-SHA256(secret, timestamp + "." + rawBody)
 * Anti-replay window: 300 seconds.
 */
export function verifyYCloudSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  try {
    if (!header) return false;

    // Parse "t=1234567890,s=abcdef..."
    const tMatch = header.match(/t=(\d+)/);
    const sMatch = header.match(/s=([0-9a-f]+)/i);
    if (!tMatch || !sMatch) return false;

    const ts = tMatch[1];
    const receivedSig = sMatch[1];

    // Anti-replay: reject if timestamp is more than 300s from now
    const nowSec = Math.floor(
      (performance.timeOrigin + performance.now()) / 1000,
    );
    if (Math.abs(nowSec - parseInt(ts, 10)) > 300) return false;

    // Compute expected HMAC
    const message = `${ts}.${rawBody}`;
    const expectedHex = createHmac("sha256", secret)
      .update(message)
      .digest("hex");

    // Constant-time comparison (pad to equal length if lengths differ — mismatched
    // lengths leak info, so we pad before comparing)
    const a = Buffer.from(expectedHex.padEnd(receivedSig.length, "0"), "utf8");
    const b = Buffer.from(receivedSig.padEnd(expectedHex.length, "0"), "utf8");

    // timingSafeEqual requires same-length buffers
    const len = Math.max(a.length, b.length);
    const aBuf = Buffer.alloc(len);
    const bBuf = Buffer.alloc(len);
    a.copy(aBuf);
    b.copy(bBuf);

    return (
      timingSafeEqual(aBuf, bBuf) && expectedHex.length === receivedSig.length
    );
  } catch {
    return false;
  }
}

export interface NormalizedInbound {
  /** The workspace phone number (E.164) that received the message */
  workspacePhone: string;
  /** Sender phone number (E.164) */
  from: string;
  /** Message type as reported by YCloud */
  type: string;
  /** The provider's own message type, before clamping (e.g. "reaction"). */
  rawType: string;
  /**
   * Text content, the media caption, "[Multimedia]" for media with neither, or
   * a readable line for button/list replies, orders and locations.
   */
  text: string | null;
  /** YCloud WhatsApp message ID */
  wamid: string;
  /** Display name from customer profile, if available */
  customerName: string | null;
  /** ISO creation timestamp from the event root */
  createTime: string;
  /** YCloud media download URL (api.ycloud.com) for media messages */
  mediaLink: string | null;
  /** YCloud media id, when present */
  mediaId: string | null;
  /** Declared MIME type of the media */
  mediaMime: string | null;
  /** Original filename (document messages) */
  mediaFilename: string | null;
}

/** Inbound message types that carry a downloadable media payload. */
const MEDIA_TYPES = ["image", "audio", "voice", "video", "document", "sticker"];

/** Valid public.message_type enum values — the DB rejects anything else. */
const MESSAGE_TYPE_ENUM = new Set([
  "text",
  "audio",
  "image",
  "document",
  "video",
  "sticker",
  "location",
  "template",
  "system",
]);

/**
 * Clamp YCloud's raw message type to a valid message_type enum value so the
 * INSERT never fails — an out-of-enum value (e.g. WhatsApp voice notes arriving
 * as 'voice', or the 'unknown' fallback) would otherwise raise 22P02 and the
 * inbound message would be silently dropped. Voice notes → 'audio'
 * (consolidateBatch handles both); anything unrecognized → 'text'. The RAW type
 * is still used above for media extraction (wimObj[msgType]).
 */
function toMessageType(raw: string): string {
  if (raw === "voice") return "audio";
  return MESSAGE_TYPE_ENUM.has(raw) ? raw : "text";
}

/**
 * Parses and normalises a raw YCloud webhook body.
 * Returns null if the event is not an inbound message or is malformed.
 */
export function parseInbound(body: unknown): NormalizedInbound | null {
  try {
    if (typeof body !== "object" || body === null) return null;

    const event = body as Record<string, unknown>;

    // Only process inbound message events
    if (event.type !== "whatsapp.inbound_message.received") return null;

    // Guard against echo messages
    if (typeof event.type === "string" && event.type.includes("echo"))
      return null;

    const wim = event.whatsappInboundMessage;
    if (typeof wim !== "object" || wim === null) return null;

    const wimObj = wim as Record<string, unknown>;

    const wamid = wimObj.wamid;
    if (typeof wamid !== "string" || !wamid) return null;

    const from = wimObj.from;
    if (typeof from !== "string" || !from) return null;

    const to = wimObj.to;
    if (typeof to !== "string" || !to) return null;

    const msgType = typeof wimObj.type === "string" ? wimObj.type : "unknown";

    const createTime =
      typeof event.createTime === "string"
        ? event.createTime
        : new Date().toISOString();

    let customerName: string | null = null;
    const profile = wimObj.customerProfile;
    if (typeof profile === "object" && profile !== null) {
      const profileObj = profile as Record<string, unknown>;
      customerName =
        typeof profileObj.name === "string" ? profileObj.name : null;
    }

    let text: string | null = null;
    let mediaLink: string | null = null;
    let mediaId: string | null = null;
    let mediaMime: string | null = null;
    let mediaFilename: string | null = null;

    if (msgType === "text") {
      const textObj = wimObj.text;
      if (typeof textObj === "object" && textObj !== null) {
        const t = (textObj as Record<string, unknown>).body;
        text = typeof t === "string" ? t : null;
      }
    } else if (MEDIA_TYPES.includes(msgType)) {
      // YCloud nests the media object under the message type, e.g.
      // whatsappInboundMessage.image = { id, link, mimeType, caption, ... }.
      // Field casing varies (mimeType vs mime_type), so read both.
      const mediaObj = wimObj[msgType];
      if (typeof mediaObj === "object" && mediaObj !== null) {
        const m = mediaObj as Record<string, unknown>;
        mediaLink = typeof m.link === "string" ? m.link : null;
        mediaId = typeof m.id === "string" ? m.id : null;
        mediaMime =
          typeof m.mimeType === "string"
            ? m.mimeType
            : typeof m.mime_type === "string"
              ? m.mime_type
              : null;
        mediaFilename = typeof m.filename === "string" ? m.filename : null;
        // Prefer the caption as the message body when present
        if (typeof m.caption === "string" && m.caption.trim()) {
          text = m.caption;
        }
      }
      if (text === null) text = "[Multimedia]";
    } else {
      // Button taps, list/interactive replies, orders, locations…
      text = inboundContentText(wimObj, msgType);
    }

    return {
      workspacePhone: to,
      from,
      type: toMessageType(msgType),
      rawType: msgType,
      text,
      wamid,
      customerName,
      createTime,
      mediaLink,
      mediaId,
      mediaMime,
      mediaFilename,
    };
  } catch {
    return null;
  }
}

/**
 * Parses a message the business sent from the WhatsApp Business App (coexistence).
 *
 * YCloud echoes these as `whatsapp.smb.message.echoes` events. Without catching
 * them, the inbox never knows someone already answered and the AI agent happily
 * replies over the human.
 *
 * History-sync backfills (`whatsapp.smb.history`) are NOT live activity and are
 * excluded — they represent old messages, not a person picking up the phone
 * right now.
 *
 * Returns null for non-echo events, malformed payloads, or events we choose to
 * skip (like history syncs).
 */
export function parseOutboundEcho(body: unknown): OutboundEcho | null {
  try {
    if (typeof body !== "object" || body === null) return null;
    const event = body as Record<string, unknown>;

    // Only process live echoes, never history backfills.
    if (event.type !== "whatsapp.smb.message.echoes") return null;

    const wm = event.whatsappMessage;
    if (typeof wm !== "object" || wm === null) return null;
    const wmObj = wm as Record<string, unknown>;

    const wamid = typeof wmObj.wamid === "string" ? wmObj.wamid : null;
    if (!wamid) return null;

    const to = typeof wmObj.to === "string" ? wmObj.to : null;
    if (!to) return null;

    const msgType = typeof wmObj.type === "string" ? wmObj.type : "unknown";

    let text: string | null = null;
    if (msgType === "text") {
      // YCloud echoes may send text as a plain string OR as { body: "..." }.
      if (typeof wmObj.text === "string") {
        text = wmObj.text;
      } else if (typeof wmObj.text === "object" && wmObj.text !== null) {
        const textObj = wmObj.text as Record<string, unknown>;
        text = typeof textObj.body === "string" ? textObj.body : null;
      }
    } else if (MEDIA_TYPES.includes(msgType)) {
      // Media messages: try caption, fall back to "[Multimedia]".
      const mediaObj = wmObj[msgType];
      if (typeof mediaObj === "object" && mediaObj !== null) {
        const m = mediaObj as Record<string, unknown>;
        if (typeof m.caption === "string" && m.caption.trim()) {
          text = m.caption;
        }
      }
      if (text === null) text = "[Multimedia]";
    } else {
      text = "[Multimedia]";
    }

    return {
      to,
      wamid,
      type: toMessageType(msgType),
      text,
      createTime:
        typeof wmObj.createTime === "string"
          ? wmObj.createTime
          : typeof event.createTime === "string"
            ? (event.createTime as string)
            : new Date().toISOString(),
      // YCloud uses phone numbers directly, not Meta phone_number_ids.
      phoneNumberId: null,
    };
  } catch {
    return null;
  }
}
