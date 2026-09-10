import { z } from "zod";
import { DEFAULT_FLOOR_CONFIG } from "@floor/domain";

const cents = z.number().int().nullable();

export const META_KEY = "lros";

export const LrosEnvelope = z.object({
  condition: z.string().nullable(),
  testStatus: z.string(),
  defectNotes: z.string().nullable(),
  mfrSerial: z.string().nullable(),
  msrpCents: cents,
  retail: z.object({
    cents,
    retailer: z.string().nullable(),
    capturedOn: z.string().nullable(),
  }),
  askCents: cents,
  floorCents: cents,
  listings: z.array(
    z.object({
      channel: z.string(),
      state: z.enum(["NOT_LISTED", "LISTED", "ENDED"]),
      url: z.string().nullable(),
      listedOn: z.string().nullable(),
    }),
  ),
  sale: z
    .object({
      priceCents: z.number().int(),
      channel: z.string(),
      soldOn: z.string(),
      salesOrderId: z.string(),
    })
    .nullable(),
  voided: z
    .object({
      reason: z.string(),
      at: z.string(),
      by: z.string(),
    })
    .nullable()
    .optional(),
  primaryAttachmentId: z.number().int().nullable().optional(),
  photoOrder: z.array(z.number().int()).optional(),
});

export type LrosEnvelope = z.infer<typeof LrosEnvelope>;

export function listingsFromConfig(channels = DEFAULT_FLOOR_CONFIG.channels) {
  return channels.map((channel) => ({
    channel: channel.id,
    state: "NOT_LISTED" as const,
    url: null,
    listedOn: null,
  }));
}

export function emptyEnvelope(): LrosEnvelope {
  return {
    condition: null,
    testStatus: "untested",
    defectNotes: null,
    mfrSerial: null,
    msrpCents: null,
    retail: { cents: null, retailer: null, capturedOn: null },
    askCents: null,
    floorCents: null,
    listings: listingsFromConfig(),
    sale: null,
    voided: null,
    primaryAttachmentId: null,
  };
}

export function mergeListings(stored: LrosEnvelope["listings"]): LrosEnvelope["listings"] {
  const byChannel = new Map(stored.map((row) => [row.channel, row]));
  const merged = listingsFromConfig().map((row) => byChannel.get(row.channel) ?? row);
  for (const row of stored) {
    if (!merged.some((m) => m.channel === row.channel)) merged.push(row);
  }
  return merged;
}
