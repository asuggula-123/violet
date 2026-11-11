import type { Clock } from '../../clock.js';
import type { Queryable } from '../../db/db.js';
import { agentsRepo } from './agents.js';
import { contactNotesRepo } from './contactNotes.js';
import { contactsRepo } from './contacts.js';
import { flagsRepo } from './flags.js';
import { householdsRepo } from './households.js';
import { inboundEventsRepo } from './inboundEvents.js';
import { messagesRepo } from './messages.js';
import { ownersRepo } from './owners.js';

export function createRepos(db: Queryable, clock: Clock) {
  return {
    households: householdsRepo(db, clock),
    owners: ownersRepo(db, clock),
    agents: agentsRepo(db, clock),
    contacts: contactsRepo(db, clock),
    contactNotes: contactNotesRepo(db, clock),
    messages: messagesRepo(db, clock),
    inboundEvents: inboundEventsRepo(db, clock),
    flags: flagsRepo(db, clock),
  };
}

export type Repos = ReturnType<typeof createRepos>;
