export interface Profile {
  displayName?: string;
  email: string;
}

export interface User {
  id: string;
  profile?: Profile;
}

const users = new Map<string, User>();

export function register(u: User): void {
  users.set(u.id, u);
}

export function find(id: string): User | undefined {
  return users.get(id);
}

export function greeting(id: string): string {
  const user = find(id);
  if (!user) return "Hello, stranger";
  return `Hello, ${user.profile.displayName ?? user.profile.email}`;
}
