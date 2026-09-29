import { createClerkClient } from '@clerk/backend';

export interface ClerkEnvironment {
  CLERK_SECRET_KEY?: string;
  VITE_CLERK_PUBLISHABLE_KEY?: string;
}

export async function authenticatedUserId(request: Request, env: ClerkEnvironment): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY || !env.VITE_CLERK_PUBLISHABLE_KEY) return null;
  try {
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
    });
    const state = await clerk.authenticateRequest(request, {
      acceptsToken: 'session_token',
      authorizedParties: [new URL(request.url).origin],
    });
    return state.isAuthenticated ? state.toAuth().userId : null;
  } catch {
    return null;
  }
}
