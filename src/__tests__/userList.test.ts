import { filterUsers } from '../lib/userList';
import { AtcHandlers } from '../handlers/AtcHandlers';
import { TransportHandlers } from '../handlers/TransportHandlers';

/**
 * Both user lists answer with the whole address book of the system - a live
 * ECC read of atcUsers came back with some 450 entries and 14 kB of names for
 * a question about one person. These hold the filter and the cap in place, and
 * the counts that say what was left out.
 */
const USERS = [
  { id: 'TESTER', title: 'Test User' },
  { id: 'ADMINSAP', title: 'ADMINSAP' },
  { id: 'DEVELOPER', title: 'Развернутое имя разработчика' },
  { id: 'WF-BATCH', title: 'Workflow background' }
];

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('filterUsers', () => {
  it('answers everything under the cap with no filter', () => {
    expect(filterUsers(USERS)).toMatchObject({ total: 4, matched: 4, returned: 4 });
  });

  it('matches the id case-insensitively', () => {
    const result = filterUsers(USERS, { filter: 'tester' });
    expect(result).toMatchObject({ total: 4, matched: 1, returned: 1 });
    expect(result.users[0].id).toBe('TESTER');
  });

  it('matches the name as well as the id, non-latin included', () => {
    expect(filterUsers(USERS, { filter: 'разработчика' }).users[0].id).toBe('DEVELOPER');
  });

  it('caps the answer and says what it left out', () => {
    const result = filterUsers(USERS, { limit: 2 });
    expect(result).toMatchObject({ total: 4, matched: 4, returned: 2, truncated: true });
    expect(result.hint).toContain('2 of 4');
  });

  it('counts the whole list even when the filter matches nothing', () => {
    expect(filterUsers(USERS, { filter: 'nobody' })).toMatchObject({ total: 4, matched: 0, returned: 0 });
  });
});

describe('atcUsers', () => {
  it('filters what the backend answered', async () => {
    const handlers = new AtcHandlers({ atcUsers: async () => USERS } as any);
    const result = answer(await handlers.handleAtcUsers({ filter: 'admin' }));
    expect(result).toMatchObject({ status: 'success', total: 4, matched: 1 });
    expect(result.users[0].id).toBe('ADMINSAP');
  });
});

describe('systemUsers', () => {
  it('filters what the backend answered', async () => {
    const handlers = new TransportHandlers({ systemUsers: async () => USERS } as any);
    const result = answer(await handlers.handleSystemUsers({ filter: 'batch' }));
    expect(result).toMatchObject({ status: 'success', total: 4, matched: 1 });
    expect(result.users[0].id).toBe('WF-BATCH');
  });
});
