import { Context } from 'hono';

import { handleMailListQuery, updateAddressUpdatedAt } from '../common';
import { getBooleanValue } from '../utils';

enum MailFlag {
    NONE = 0,
    FLAGGED = 1,
}

type MailScope = {
    listQuery: string;
    countQuery: string;
    updateReadQuery: string;
    markAllReadQuery: string;
    updateFlagQuery: string;
    params: string[];
};

const ADDRESS_MAIL_QUERIES = {
    listQuery: `SELECT * FROM raw_mails
        WHERE address = ? AND CASE ?
            WHEN 'all' THEN 1
            WHEN 'unread' THEN is_unread = 1
            WHEN 'read' THEN is_unread = 0
            WHEN 'flagged' THEN mail_flag = 1
            ELSE 0
        END`,
    countQuery: `SELECT count(*) AS count FROM raw_mails
        WHERE address = ? AND CASE ?
            WHEN 'all' THEN 1
            WHEN 'unread' THEN is_unread = 1
            WHEN 'read' THEN is_unread = 0
            WHEN 'flagged' THEN mail_flag = 1
            ELSE 0
        END`,
    updateReadQuery: `UPDATE raw_mails SET is_unread = ?
        WHERE id IN (SELECT value FROM json_each(?)) AND address = ?
        RETURNING id, is_unread`,
    markAllReadQuery: `UPDATE raw_mails SET is_unread = 0
        WHERE is_unread = 1 AND address = ?`,
    updateFlagQuery: `UPDATE raw_mails SET mail_flag = ?
        WHERE id IN (SELECT value FROM json_each(?)) AND address = ?
        RETURNING id, mail_flag`,
};

const USER_MAIL_QUERIES = {
    listQuery: `SELECT * FROM raw_mails
        WHERE address IN (
            SELECT a.name FROM users_address ua
            JOIN address a ON a.id = ua.address_id
            WHERE ua.user_id = ? AND (? = '' OR a.name = ?)
        ) AND CASE ?
            WHEN 'all' THEN 1
            WHEN 'unread' THEN is_unread = 1
            WHEN 'read' THEN is_unread = 0
            WHEN 'flagged' THEN mail_flag = 1
            ELSE 0
        END`,
    countQuery: `SELECT count(*) AS count FROM raw_mails
        WHERE address IN (
            SELECT a.name FROM users_address ua
            JOIN address a ON a.id = ua.address_id
            WHERE ua.user_id = ? AND (? = '' OR a.name = ?)
        ) AND CASE ?
            WHEN 'all' THEN 1
            WHEN 'unread' THEN is_unread = 1
            WHEN 'read' THEN is_unread = 0
            WHEN 'flagged' THEN mail_flag = 1
            ELSE 0
        END`,
    updateReadQuery: `UPDATE raw_mails SET is_unread = ?
        WHERE id IN (SELECT value FROM json_each(?)) AND address IN (
            SELECT a.name FROM users_address ua
            JOIN address a ON a.id = ua.address_id
            WHERE ua.user_id = ? AND (? = '' OR a.name = ?)
        ) RETURNING id, is_unread`,
    markAllReadQuery: `UPDATE raw_mails SET is_unread = 0
        WHERE is_unread = 1 AND address IN (
            SELECT a.name FROM users_address ua
            JOIN address a ON a.id = ua.address_id
            WHERE ua.user_id = ? AND (? = '' OR a.name = ?)
        )`,
    updateFlagQuery: `UPDATE raw_mails SET mail_flag = ?
        WHERE id IN (SELECT value FROM json_each(?)) AND address IN (
            SELECT a.name FROM users_address ua
            JOIN address a ON a.id = ua.address_id
            WHERE ua.user_id = ? AND (? = '' OR a.name = ?)
        ) RETURNING id, mail_flag`,
};

const parseIds = (value: unknown): number[] | null => {
    if (!value || typeof value !== 'object') return null;
    const ids = (value as Record<string, unknown>).ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) return null;
    if (ids.some(id => typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) return null;
    return [...new Set<number>(ids)];
};

const addressMailScope = (c: Context<HonoCustomType>): MailScope => ({
    ...ADDRESS_MAIL_QUERIES,
    params: [c.get('jwtPayload').address],
});

const userMailScope = (c: Context<HonoCustomType>): MailScope => {
    const address = c.req.query('address')?.trim() ?? '';
    return {
        ...USER_MAIL_QUERIES,
        params: [String(c.get('userPayload').user_id), address, address],
    };
};

const getMailViews = (c: Context<HonoCustomType>) => {
    const readEnabled = getBooleanValue(c.env.ENABLE_MAIL_READ_STATUS);
    const flagEnabled = getBooleanValue(c.env.ENABLE_MAIL_FLAG);
    if (!readEnabled && !flagEnabled) return c.json({ error: 'Mail state is disabled' }, 403);
    return c.json({
        results: [
            { value: 'all', label_key: 'allMail' },
            ...(readEnabled ? [
                { value: 'unread', label_key: 'unread' },
                { value: 'read', label_key: 'read' },
            ] : []),
            ...(flagEnabled ? [
                { value: 'flagged', label_key: 'flagged' },
            ] : []),
        ],
    });
};

const listMailView = async (c: Context<HonoCustomType>, scope: MailScope) => {
    const readEnabled = getBooleanValue(c.env.ENABLE_MAIL_READ_STATUS);
    const flagEnabled = getBooleanValue(c.env.ENABLE_MAIL_FLAG);
    if (!readEnabled && !flagEnabled) {
        return c.json({ error: 'Mail state is disabled' }, 403);
    }
    const { limit, offset, view } = c.req.query();
    const filters: Record<string, boolean> = {
        all: true,
        unread: readEnabled,
        read: readEnabled,
        flagged: flagEnabled,
    };
    if (!view || !filters[view]) return c.json({ error: 'Invalid mail view' }, 400);

    return await handleMailListQuery(
        c,
        scope.listQuery,
        scope.countQuery,
        [...scope.params, view],
        limit,
        offset,
    );
};

const updateReadStatus = async (c: Context<HonoCustomType>, scope: MailScope) => {
    if (!getBooleanValue(c.env.ENABLE_MAIL_READ_STATUS)) {
        return c.json({ error: 'Mail read status is disabled' }, 403);
    }

    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const ids = parseIds(body);
    if (!ids || typeof body?.read !== 'boolean') {
        return c.json({ error: 'Invalid mail read request' }, 400);
    }
    const isUnread = body.read ? 0 : 1;
    const result = await c.env.DB.prepare(scope.updateReadQuery)
        .bind(isUnread, JSON.stringify(ids), ...scope.params).all<{
        id: number;
        is_unread: number;
    }>();
    return c.json({
        success: result.success,
        changes: result.meta.changes ?? 0,
        results: result.results,
    }, result.success ? 200 : 500);
};

const markAllRead = async (c: Context<HonoCustomType>, scope: MailScope) => {
    if (!getBooleanValue(c.env.ENABLE_MAIL_READ_STATUS)) {
        return c.json({ error: 'Mail read status is disabled' }, 403);
    }

    const result = await c.env.DB.prepare(scope.markAllReadQuery).bind(...scope.params).run();
    return c.json({
        success: result.success,
        changes: result.meta.changes ?? 0,
    }, result.success ? 200 : 500);
};

const updateMailFlag = async (c: Context<HonoCustomType>, scope: MailScope) => {
    if (!getBooleanValue(c.env.ENABLE_MAIL_FLAG)) {
        return c.json({ error: 'Mail flag is disabled' }, 403);
    }

    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const ids = parseIds(body);
    const flag = body?.flag === 'flagged'
        ? MailFlag.FLAGGED
        : body?.flag === 'none'
            ? MailFlag.NONE
            : null;
    if (!ids || flag === null) return c.json({ error: 'Invalid mail flag request' }, 400);

    const result = await c.env.DB.prepare(scope.updateFlagQuery)
        .bind(flag, JSON.stringify(ids), ...scope.params).all<{
        id: number;
        mail_flag: number;
    }>();
    return c.json({
        success: result.success,
        changes: result.meta.changes ?? 0,
        results: result.results,
    }, result.success ? 200 : 500);
};

const listAddressMailView = (c: Context<HonoCustomType>) => {
    const { address } = c.get('jwtPayload');
    const offset = c.req.query('offset');
    if (offset && Number.parseInt(offset) <= 0) updateAddressUpdatedAt(c, address);
    return listMailView(c, addressMailScope(c));
};

export const addressMailState = {
    getViews: getMailViews,
    listView: listAddressMailView,
    updateRead: (c: Context<HonoCustomType>) => updateReadStatus(c, addressMailScope(c)),
    markAllRead: (c: Context<HonoCustomType>) => markAllRead(c, addressMailScope(c)),
    updateFlag: (c: Context<HonoCustomType>) => updateMailFlag(c, addressMailScope(c)),
};

export const userMailState = {
    getViews: getMailViews,
    listView: (c: Context<HonoCustomType>) => listMailView(c, userMailScope(c)),
    updateRead: (c: Context<HonoCustomType>) => updateReadStatus(c, userMailScope(c)),
    markAllRead: (c: Context<HonoCustomType>) => markAllRead(c, userMailScope(c)),
    updateFlag: (c: Context<HonoCustomType>) => updateMailFlag(c, userMailScope(c)),
};
