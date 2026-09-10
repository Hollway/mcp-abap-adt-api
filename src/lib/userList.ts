/**
 * Cutting a system's user list down to what was asked for.
 *
 * Both user lists this server exposes - ATC's approvers and the transport
 * tools' users - are the whole address book of the system: several hundred
 * entries, tens of kilobytes, on a productive landscape. They are read to find
 * one person, so answering with all of them spends the caller's context on
 * names nobody asked about.
 */

export interface NamedUser {
    id?: string;
    title?: string;
    [key: string]: any;
}

export interface UserListOptions {
    /** Case-insensitive substring, matched against both id and title. */
    filter?: unknown;
    /** Cap on the users reported. The counts are always for everything found. */
    limit?: unknown;
}

export interface UserListResult<T> {
    total: number;
    matched: number;
    returned: number;
    users: T[];
    truncated?: true;
    hint?: string;
}

export const DEFAULT_USER_LIMIT = 50;

export const filterUsers = <T extends NamedUser>(
    users: T[],
    options: UserListOptions = {}
): UserListResult<T> => {
    const all = Array.isArray(users) ? users : [];
    const needle = typeof options.filter === 'string' ? options.filter.trim().toLowerCase() : '';
    const matched = needle
        ? all.filter(user =>
              `${user?.id ?? ''} ${user?.title ?? ''}`.toLowerCase().includes(needle)
          )
        : all;

    const asked = Number(options.limit);
    const limit = Number.isFinite(asked) && asked >= 0 ? asked : DEFAULT_USER_LIMIT;
    const reported = matched.slice(0, limit);

    const result: UserListResult<T> = {
        total: all.length,
        matched: matched.length,
        returned: reported.length,
        users: reported
    };

    if (reported.length < matched.length) {
        result.truncated = true;
        result.hint = needle
            ? `Showing ${reported.length} of ${matched.length} users matching '${needle}'. Narrow the filter, or raise limit.`
            : `Showing ${reported.length} of ${matched.length} users. Pass filter to search by name, or raise limit.`;
    }

    return result;
};
