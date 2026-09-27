/**
 * Which transport this build uses. One decision, made once, from config.
 *
 *   VITE_BOARD_API_URL set  -> the board API (the network and comms views
 *                              over HTTP, from the real table)
 *   otherwise               -> computed in the tab, from the in-memory store
 *
 * Sign-in is the real pool either way (auth/provider.ts), so the token the
 * API needs is always one it can verify.
 */
import type { Transport } from './index.ts';
import { inProcessTransport } from './in-process.ts';
import { apiTransport, boardApiUrl } from './api.ts';

export const usingBoardApi = Boolean(boardApiUrl());

export const transport: Transport = usingBoardApi ? apiTransport : inProcessTransport;
