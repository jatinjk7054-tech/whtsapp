import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate } from '../middleware/auth.js';
import { HttpError } from '../lib/HttpError.js';
import { createOutboundConversation } from '../conversations/conversation.repository.js';
import { normalizeWaId, createContact, getContactByWaId, getContactProfile } from './contact.repository.js';
import {
  addContactTags,
  getContactTags,
  linkTagsByNames,
  listTags,
  removeContactTag,
} from '../tags/tag.repository.js';

export const contactRouter = Router();

contactRouter.use(authenticate);

const pictureParams = z.object({ waId: z.string().regex(/^\d{8,15}$/) });

const contactBody = z.object({
  name: z.string().trim().min(1).max(120),
  mobile: z.string().trim().min(1).max(32),
  // Internal-only CRM fields. Notes are never sent to WhatsApp, and tags are a
  // simple label list kept on the contact row.
  notes: z.string().trim().max(4000).optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
});

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

/** Accepts "New, VIP" or ["New","VIP"]; trims, drops empties, dedupes case-insensitively. */
function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const tags = [];
  for (const raw of list) {
    const tag = String(raw).trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    if (!tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * Ownership check shared by every customer-scoped route. Admins may open any
 * customer; an agent only the customer whose conversation is assigned to them.
 * It mirrors getThread/setStatus, so a direct tag-API call against another
 * agent's conversation is refused with 403 by the backend, not just hidden in
 * the UI (§11).
 */
function assertProfileAccess(profile, staff) {
  if (staff.role === 'admin') return;
  if (profile.conversation_id == null || profile.assigned_staff_id !== staff.id) {
    throw new HttpError(403, 'This conversation is assigned to another staff member');
  }
}

async function loadAccessibleProfile(waId, staff) {
  const profile = await getContactProfile(waId);
  if (!profile) throw new HttpError(404, 'Contact not found');
  assertProfileAccess(profile, staff);
  return profile;
}

/**
 * Add Contact: saves name + mobile (+ optional internal notes/tags), normalising
 * the number into the E.164 wa_id the webhook matches on. An existing number is
 * rejected with 409 "Contact already exists" — it is never duplicated or
 * overwritten. The new conversation is returned so the UI can show the contact
 * without a page refresh.
 */
contactRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { name, mobile, notes, tags } = contactBody.parse(req.body);
    const waId = normalizeWaId(mobile);
    if (!/^\d{8,15}$/.test(waId)) {
      throw new HttpError(422, 'Enter a valid WhatsApp number with country code, for example 919876543210');
    }

    const existing = await getContactByWaId(waId);
    if (existing) {
      throw new HttpError(409, 'Contact already exists');
    }

    const tagNames = parseTags(tags);

    let contact;
    try {
      contact = await createContact(waId, { name, notes: notes ?? '', tags: tagNames });
    } catch (error) {
      // UNIQUE index on wa_id: another request won the race between the check above.
      if (error?.code === '23505') throw new HttpError(409, 'Contact already exists');
      throw error;
    }

    // Module 5: the free-text tags typed here become real tag rows (a new name
    // creates a custom tag) linked to this customer, so they appear in the
    // profile, the conversation list and the tag filter like any other tag.
    if (tagNames.length > 0) await linkTagsByNames(contact.id, tagNames);

    // Same ownership rule as starting a chat: admins never self-assign; an
    // agent claims the thread only when it is new or unassigned.
    const assigned = req.staff.role === 'admin' ? undefined : req.staff.id;
    const conversation = await createOutboundConversation(waId, contact.name, assigned);

    if (req.staff.role !== 'admin' && conversation.assigned_staff_id !== req.staff.id) {
      throw new HttpError(403, 'This customer is already assigned to another staff member');
    }

    res.status(201).json({ contact, conversation });
  })
);

/**
 * Customer Profile: name, number, first contact date, last message, assigned
 * agent, tags and internal notes in one call. Ownership matches getThread —
 * an agent can only open the profile of their own customer, an admin of any.
 */
contactRouter.get(
  '/:waId/profile',
  asyncRoute(async (req, res) => {
    const { waId } = pictureParams.parse(req.params);
    const profile = await loadAccessibleProfile(waId, req.staff);
    const tags = profile.tag_list ?? [];

    res.json({
      contact: {
        id: profile.contact_id,
        wa_id: profile.wa_id,
        name: profile.name,
        notes: profile.notes,
        // Module 1 contract: plain names. The Module 5 objects (id + colour)
        // travel alongside in `tags` below, both derived from contact_tags so
        // a rename is reflected immediately.
        tags: tags.map((tag) => tag.name),
        first_contact_at: profile.first_contact_at,
      },
      tags,
      conversation: profile.conversation_id == null
        ? null
        : {
            id: profile.conversation_id,
            status: profile.conversation_status,
            assigned_staff_id: profile.assigned_staff_id,
            assigned_staff_name: profile.assigned_staff_name,
            last_message_at: profile.last_message_at,
          },
      lastMessage: profile.last_message_at_exact == null
        ? null
        : {
            body: profile.last_message_body,
            direction: profile.last_message_direction,
            created_at: profile.last_message_at_exact,
          },
    });
  })
);

const tagIdsBody = z.object({
  tagIds: z.array(z.coerce.number().int().positive()).min(1).max(MAX_TAGS),
});

const tagParams = z.object({
  waId: z.string().regex(/^\d{8,15}$/),
  tagId: z.coerce.number().int().positive(),
});

/**
 * Module 5 — customer tags. Same ownership rule as the profile and the thread
 * (assertProfileAccess), so an agent tagging a customer they cannot open gets
 * 403 from the backend even with a hand-written API call (§11).
 */
contactRouter.get(
  '/:waId/tags',
  asyncRoute(async (req, res) => {
    const { waId } = pictureParams.parse(req.params);
    const profile = await loadAccessibleProfile(waId, req.staff);
    res.json({ tags: await getContactTags(profile.contact_id) });
  })
);

/** Adds one or more tags (idempotent) and returns the customer's full tag list. */
contactRouter.post(
  '/:waId/tags',
  asyncRoute(async (req, res) => {
    const { waId } = pictureParams.parse(req.params);
    const { tagIds } = tagIdsBody.parse(req.body);
    const profile = await loadAccessibleProfile(waId, req.staff);

    // An id that is not in the catalogue means the tag was deleted while the
    // UI still had it open — a clean 422 beats a foreign-key 400.
    const known = new Set((await listTags()).map((tag) => tag.id));
    if (tagIds.some((id) => !known.has(id))) {
      throw new HttpError(422, 'One or more tags no longer exist');
    }

    res.json({ tags: await addContactTags(profile.contact_id, tagIds) });
  })
);

/** Removes a single tag from a customer. Customers and chats are untouched. */
contactRouter.delete(
  '/:waId/tags/:tagId',
  asyncRoute(async (req, res) => {
    const { waId, tagId } = tagParams.parse(req.params);
    const profile = await loadAccessibleProfile(waId, req.staff);
    res.json({ tags: await removeContactTag(profile.contact_id, tagId) });
  })
);

/**
 * Customer profile picture proxy. IMPORTANT: the WhatsApp Cloud API has no
 * endpoint that returns a customer's profile picture — `GET /contacts/:waId/picture`
 * returns #2500 "Unknown path components" and `contacts` is not even an edge
 * on the WABA (#100). The webhook only carries wa_id + profile.name. So the
 * endpoint deliberately reports 404 (no picture) and the frontend falls back to
 * the initials avatar. It stays as the contract point so an operator-provided
 * or future SDK picture can be streamed here without touching the UI.
 */
contactRouter.get(
  '/:waId/picture',
  asyncRoute(async (req, res) => {
    const { waId } = pictureParams.parse(req.params);
    await loadAccessibleProfile(waId, req.staff);

    throw new HttpError(404, 'WhatsApp Cloud API does not provide customer profile pictures');
  })
);
