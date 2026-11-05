// After a name in a task's mcp list, it marks a server the task can go without (D49). No server's
// name holds one, so it can't be read as part of a name.
export const OPTIONAL = '?';

export type ListItem = {
    readonly name: string;
    readonly optional: boolean;
};

export const parseListItem = (item: string): ListItem => {
    const optional = item.endsWith(OPTIONAL);

    return { name: optional ? item.slice(0, -1) : item, optional };
};
