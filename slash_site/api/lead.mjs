// Vercel: серверная функция по адресу /api/lead
import { handleLead } from "../lib/lead-core.mjs";

const run = (request) => handleLead(request, process.env);

export const POST = run;
export const OPTIONS = run;
export const GET = run;
