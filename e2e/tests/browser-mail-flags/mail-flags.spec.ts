import { expect, request as apiRequest, test } from '@playwright/test';

import {
  FRONTEND_MAIL_FLAGS_URL,
  WORKER_MAIL_FLAGS_URL,
  createTestAddress,
  deleteAddress,
  seedTestMail,
} from '../../fixtures/test-helpers';

test('opens, marks, flags and filters mail', async ({ page }) => {
  const request = await apiRequest.newContext();
  let jwt: string | undefined;
  try {
    const mailbox = await createTestAddress(
      request, 'mail-state-browser', 'test.example.com', WORKER_MAIL_FLAGS_URL,
    );
    jwt = mailbox.jwt;
    const subject = `Unread browser mail ${Date.now()}`;
    await seedTestMail(request, mailbox.address, { subject }, WORKER_MAIL_FLAGS_URL);

    await page.goto(`${FRONTEND_MAIL_FLAGS_URL}/en/`);
    await page.evaluate(() => localStorage.setItem('mailListView', 'true'));
    await page.goto(`${FRONTEND_MAIL_FLAGS_URL}/en/?jwt=${jwt}`);
    await expect(page.getByText(subject, { exact: true })).toBeVisible({ timeout: 10_000 });

    const readResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/mails/read'
      && response.request().method() === 'PATCH'
    );
    await page.getByText(subject, { exact: true }).click();
    expect((await readResponse).ok()).toBe(true);
    await expect(page.getByRole('button', { name: 'Mark as Unread' })).toBeVisible();

    const flagResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/mails/flag'
      && response.request().method() === 'PATCH'
    );
    await page.getByRole('button', { name: 'Add Star' }).click();
    expect((await flagResponse).ok()).toBe(true);
    await expect(page.getByRole('button', { name: 'Remove Star' })).toBeVisible();

    await page.getByRole('button', { name: 'Back to List' }).click();
    const flaggedView = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/mail_view' && url.searchParams.get('view') === 'flagged';
    });
    await page.locator('.n-select').filter({ hasText: 'All Mail' }).first().click();
    await page.locator('.n-base-select-option').filter({ hasText: /^Flagged$/ }).click();
    expect((await flaggedView).ok()).toBe(true);
    await expect(page.getByText(subject, { exact: true })).toBeVisible();
  } finally {
    try {
      if (jwt) await deleteAddress(request, jwt, WORKER_MAIL_FLAGS_URL);
    } finally {
      await request.dispose();
    }
  }
});
