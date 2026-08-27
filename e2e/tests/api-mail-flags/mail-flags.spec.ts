import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  WORKER_MAIL_FLAGS_URL,
  WORKER_URL,
  createTestAddress,
  deleteAddress,
  hashPassword,
  seedTestMail,
} from '../../fixtures/test-helpers';

const headers = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

const createUser = async (request: APIRequestContext) => {
  const email = `mail-flags-${Date.now()}@test.example.com`;
  const password = hashPassword('test-password-123');
  const register = await request.post(`${WORKER_MAIL_FLAGS_URL}/user_api/register`, {
    data: { email, password },
  });
  expect(register.ok()).toBe(true);
  const login = await request.post(`${WORKER_MAIL_FLAGS_URL}/user_api/login`, {
    data: { email, password },
  });
  expect(login.ok()).toBe(true);
  const { jwt } = await login.json();
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  return { jwt, userId: payload.user_id as number };
};

test.describe('Mail read status and flags', () => {
  test('keeps historical mail read and supports read and flag lifecycle', async ({ request }) => {
    const mailbox = await createTestAddress(
      request, 'mail-flags', 'test.example.com', WORKER_MAIL_FLAGS_URL,
    );
    try {
      const historical = await request.post(`${WORKER_MAIL_FLAGS_URL}/admin/test/seed_mail`, {
        data: {
          address: mailbox.address,
          source: 'sender@test.example.com',
          raw: 'From: sender@test.example.com\r\nSubject: Historical\r\n\r\nHistorical',
        },
      });
      expect(historical.ok()).toBe(true);
      await seedTestMail(
        request, mailbox.address, { subject: 'New unread mail' }, WORKER_MAIL_FLAGS_URL,
      );

      const list = await request.get(`${WORKER_MAIL_FLAGS_URL}/api/mails?limit=10&offset=0`, {
        headers: headers(mailbox.jwt),
      });
      const mails = (await list.json()).results;
      expect(mails).toHaveLength(2);
      expect(mails.find((mail: any) => mail.raw.includes('Historical')).is_unread).toBe(0);
      const unreadMail = mails.find((mail: any) => mail.raw.includes('New unread mail'));
      expect(unreadMail).toMatchObject({ is_unread: 1, mail_flag: 0 });

      const views = await request.get(`${WORKER_MAIL_FLAGS_URL}/api/mail_views`, {
        headers: headers(mailbox.jwt),
      });
      expect((await views.json()).results.map((view: any) => view.value))
        .toEqual(['all', 'unread', 'read', 'flagged']);

      const allView = await request.get(
        `${WORKER_MAIL_FLAGS_URL}/api/mail_view?limit=10&offset=0&view=all`,
        { headers: headers(mailbox.jwt) },
      );
      expect((await allView.json()).results).toHaveLength(2);

      const unreadView = await request.get(
        `${WORKER_MAIL_FLAGS_URL}/api/mail_view?limit=10&offset=0&view=unread`,
        { headers: headers(mailbox.jwt) },
      );
      expect((await unreadView.json()).results.map((mail: any) => mail.id)).toEqual([unreadMail.id]);

      const markRead = await request.patch(`${WORKER_MAIL_FLAGS_URL}/api/mails/read`, {
        headers: headers(mailbox.jwt),
        data: { ids: [unreadMail.id], read: true },
      });
      expect((await markRead.json()).results).toEqual([{ id: unreadMail.id, is_unread: 0 }]);

      const addFlag = await request.patch(`${WORKER_MAIL_FLAGS_URL}/api/mails/flag`, {
        headers: headers(mailbox.jwt),
        data: { ids: [unreadMail.id], flag: 'flagged' },
      });
      expect((await addFlag.json()).results).toEqual([{ id: unreadMail.id, mail_flag: 1 }]);

      const flaggedView = await request.get(
        `${WORKER_MAIL_FLAGS_URL}/api/mail_view?limit=10&offset=0&view=flagged`,
        { headers: headers(mailbox.jwt) },
      );
      expect((await flaggedView.json()).results.map((mail: any) => mail.id)).toEqual([unreadMail.id]);

      await request.patch(`${WORKER_MAIL_FLAGS_URL}/api/mails/read`, {
        headers: headers(mailbox.jwt),
        data: { ids: [unreadMail.id], read: false },
      });
      const markAll = await request.patch(`${WORKER_MAIL_FLAGS_URL}/api/mails/read-all`, {
        headers: headers(mailbox.jwt),
      });
      expect(markAll.ok()).toBe(true);

      const noUnread = await request.get(
        `${WORKER_MAIL_FLAGS_URL}/api/mail_view?limit=10&offset=0&view=unread`,
        { headers: headers(mailbox.jwt) },
      );
      expect((await noUnread.json()).results).toHaveLength(0);
    } finally {
      await deleteAddress(request, mailbox.jwt, WORKER_MAIL_FLAGS_URL);
    }
  });

  test('scopes mutations to the authenticated address and disables new APIs by default', async ({ request }) => {
    const first = await createTestAddress(
      request, 'mail-scope-first', 'test.example.com', WORKER_MAIL_FLAGS_URL,
    );
    const second = await createTestAddress(
      request, 'mail-scope-second', 'test.example.com', WORKER_MAIL_FLAGS_URL,
    );
    try {
      await seedTestMail(request, second.address, { subject: 'Second mail' }, WORKER_MAIL_FLAGS_URL);
      const secondList = await request.get(
        `${WORKER_MAIL_FLAGS_URL}/api/mails?limit=10&offset=0`,
        { headers: headers(second.jwt) },
      );
      const secondMail = (await secondList.json()).results[0];

      await request.patch(`${WORKER_MAIL_FLAGS_URL}/api/mails/read`, {
        headers: headers(first.jwt),
        data: { ids: [secondMail.id], read: true },
      });
      const unchanged = await request.get(
        `${WORKER_MAIL_FLAGS_URL}/api/mails?limit=10&offset=0`,
        { headers: headers(second.jwt) },
      );
      expect((await unchanged.json()).results[0].is_unread).toBe(1);

      const disabledMailbox = await createTestAddress(request, 'mail-disabled');
      try {
        const disabledViews = await request.get(`${WORKER_URL}/api/mail_views`, {
          headers: headers(disabledMailbox.jwt),
        });
        expect(disabledViews.status()).toBe(403);
        const disabledUpdate = await request.patch(`${WORKER_URL}/api/mails/read`, {
          headers: headers(disabledMailbox.jwt),
          data: { ids: [1], read: true },
        });
        expect(disabledUpdate.status()).toBe(403);
      } finally {
        await deleteAddress(request, disabledMailbox.jwt);
      }
    } finally {
      await deleteAddress(request, first.jwt, WORKER_MAIL_FLAGS_URL);
      await deleteAddress(request, second.jwt, WORKER_MAIL_FLAGS_URL);
    }
  });

  test('supports User JWT scope and address-filtered mark-all-read', async ({ request }) => {
    const addresses: Awaited<ReturnType<typeof createTestAddress>>[] = [];
    let userId: number | undefined;
    let originalSettings: Record<string, unknown> | undefined;
    try {
      const settings = await request.get(`${WORKER_MAIL_FLAGS_URL}/admin/user_settings`);
      originalSettings = await settings.json();
      await request.post(`${WORKER_MAIL_FLAGS_URL}/admin/user_settings`, {
        data: { ...originalSettings, enable: true, enableMailVerify: false, maxAddressCount: 0 },
      });
      const user = await createUser(request);
      userId = user.userId;
      const bound = await createTestAddress(
        request, 'mail-flags-user', 'test.example.com', WORKER_MAIL_FLAGS_URL,
      );
      const outsider = await createTestAddress(
        request, 'mail-flags-outsider', 'test.example.com', WORKER_MAIL_FLAGS_URL,
      );
      addresses.push(bound, outsider);
      const bind = await request.post(`${WORKER_MAIL_FLAGS_URL}/user_api/bind_address`, {
        headers: { ...headers(bound.jwt), 'x-user-token': user.jwt },
      });
      expect(bind.ok()).toBe(true);
      await seedTestMail(request, bound.address, { subject: 'Bound unread' }, WORKER_MAIL_FLAGS_URL);
      await seedTestMail(request, outsider.address, { subject: 'Outsider unread' }, WORKER_MAIL_FLAGS_URL);

      const unread = await request.get(
        `${WORKER_MAIL_FLAGS_URL}/user_api/mail_view?view=unread&limit=10&offset=0`,
        { headers: { 'x-user-token': user.jwt } },
      );
      const unreadMails = (await unread.json()).results;
      expect(unreadMails).toHaveLength(1);
      expect(unreadMails[0].address).toBe(bound.address);

      const addFlag = await request.patch(`${WORKER_MAIL_FLAGS_URL}/user_api/mails/flag`, {
        headers: { 'x-user-token': user.jwt },
        data: { ids: [unreadMails[0].id], flag: 'flagged' },
      });
      expect(addFlag.ok()).toBe(true);
      const markAll = await request.patch(
        `${WORKER_MAIL_FLAGS_URL}/user_api/mails/read-all?address=${encodeURIComponent(bound.address)}`,
        { headers: { 'x-user-token': user.jwt } },
      );
      expect(markAll.ok()).toBe(true);
      expect((await markAll.json()).changes).toBe(1);
    } finally {
      await Promise.allSettled(addresses.map(address =>
        deleteAddress(request, address.jwt, WORKER_MAIL_FLAGS_URL)
      ));
      if (userId !== undefined) {
        await request.delete(`${WORKER_MAIL_FLAGS_URL}/admin/users/${userId}`);
      }
      if (originalSettings) {
        await request.post(`${WORKER_MAIL_FLAGS_URL}/admin/user_settings`, {
          data: originalSettings,
        });
      }
    }
  });
});
