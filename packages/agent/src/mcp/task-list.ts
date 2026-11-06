// After a name in a task's mcp list, it marks a server the task can go without (D49). No server's
// name holds one, so it can't be read as part of a name.
export const OPTIONAL = '?';

export type ListItem = {
    readonly name: string;
    readonly optional: boolean;
};

export const parseListItem = (item: string): ListItem => {
    if (item.endsWith(OPTIONAL)) {
        return { name: item.slice(0, -1), optional: true };
    }

    return { name: item, optional: false };
};
