# Publishing policy: what the team layer may contain

**Draft, 23 Nov 2026, for Usman to edit. Tier sections added 25 Nov (slice P).** The curator agent follows this file on every scheduled run. Change it, and re-run the curator to apply the change to everything already gathered.

## The test

Publish a fact only if a member of the MyTT delivery team needs it to do their work: to build, test, plan, unblock someone, or stay consistent with a decision. "Interesting" is not enough.

**When in doubt, withhold or flag. Never publish on a guess.**

## The three tiers

Every published item is written for one tier, and a source usually becomes
several items, one per tier, each carrying the right amount of detail.

**Read the numbers carefully. Tier 1 is the most restricted, not the least.**

| Tier | Who is in it | Sees |
|---|---|---|
| **1. Governance** | The tech lead and the PM | Everything in the team layer |
| **2. Leads** | Tier 1, plus the team leads | Tiers 2 and 3 |
| **3. Delivery** | Everyone: developers, QA, people on the ground | Tier 3 only |

So an item marked **tier 1 is seen by two people**, and an item marked **tier 3
is seen by the whole team**. Marking something tier 1 restricts it; marking it
tier 3 publishes it widely. If you are about to mark a sensitive fact "tier 3"
because it feels like the careful choice, you have the ladder upside down.

**Give each item the lowest-numbered tier that still needs it.** A fact
everyone needs is tier 3. A fact only the leads need is tier 2. A fact only
governance should hold is tier 1.

### Tier 3 — delivery

What someone needs to build, test or unblock their own work today.

- Scope: what is in and out, acceptance criteria, changes to either.
- Decisions, as agreed or proposed, with their scope.
- Dates: deadlines, milestones, sprint goals, release plans — the date, not
  the reason behind it.
- Blockers and dependencies: what is waiting on what, and on whom.
- Action items with their owner and due date.
- Technical facts: architecture, contracts, environments, known bugs,
  incidents and their fixes.
- Open questions the team is waiting on.

Never at tier 3: why a date moved, if the reason is commercial or about a
person; anything about an individual's performance; any figure.

### Tier 2 — leads

Everything at tier 3, plus what someone running a workstream needs.

- Delivery planning across more than one person's work.
- Cross-team risks and dependencies.
- Internal estimates, in time rather than money: "about two sprints", never a
  cost. A cost is tier 1.
- Allocation: who is on what, and what moves if something slips.
- Capacity constraints, as constraints rather than as judgements about people:
  "QA capacity is the limit this sprint", never "QA is slow".

### Tier 1 — governance

Everything at tiers 2 and 3, plus what only the tech lead and the PM should
hold.

- Commercial terms, rates, budgets, invoices and margins.
- Estimates given to the client, and the gap between those and the internal
  ones.
- Contract and scope-change matters, including change orders not yet approved.
- Staffing and allocation decisions that involve individuals.
- Programme-level risks, including the client relationship.
- The commercial or political reason behind a date, a scope change or a
  reprioritisation.

**Tier 1 is not a place to put anything awkward.** Material about a person's
performance, pay, punctuality or conduct does not belong in the brain at any
tier — see *Leave out* and *Never published* below. Tier 1 is for work that is
commercially or contractually sensitive, not for anything you would rather the
team did not read.


## Publish

Rewrite it for the team, in neutral language, and cite the source.

- **Decisions:** what was decided, the scope, and when. Use the role or team ("the client", "backend") rather than a person's name, unless the name is what someone needs: the owner of an action, or who to ask.
- **Scope and requirements:** what's in and out, acceptance criteria, changes to either.
- **Dates:** deadlines, milestones, sprint goals, release plans.
- **Blockers and dependencies:** what's waiting on what, and on whom.
- **Action items:** the owner and due date for team work.
- **Technical facts:** architecture, contracts, environments, known bugs, incidents and their fixes.
- **Status:** ticket and backlog progress, carry-over, risks to delivery.
- **Open questions** waiting on an answer the team needs.

## Leave out

Write the team item without these. Record each left-out detail in the digest, as a category and not the content, for example "left out: rate figures".

- **Commercial:** prices, rates, hours billed, budgets, invoices, contract terms, margins, estimates given to the client unless already agreed and published.
- **People matters:** performance, punctuality, work-log shortfalls, pay, leave reasons, health, hiring, disputes, and any judgement about an individual.
- **Personal data:** phone numbers, personal emails, ID or account numbers, home details, and anything about a citizen or a real user of MyTT.
- **Credentials and access:** keys, tokens, passwords, connection strings, internal URLs carrying secrets.
- **Client relationship:** frustration, politics, negotiation positions, remarks about the client's people, internal views of the client.
- **Security weaknesses**, in detail. Publish "a security fix is planned for uploads"; leave out how to exploit the gap.
- **Off-topic:** other projects, small talk, personal conversation.

## Flag for Usman

Don't publish. Put it in the review queue with a one-line reason.

- A decision that sounds agreed but isn't confirmed ("I think we'll go with…").
- Something the team needs that's tangled up with a "leave out" category. For example, a deadline that moved for a commercial reason: the new date can be published, the reason can't.
- Criticism of a person or a team, even if constructive.
- Anything about the client's internal plans or other vendors.
- A source this policy doesn't clearly cover.
- Anything that contradicts an agreed decision in the register.

## How to write a team item

- One idea per item. A meeting becomes several items, not one long summary.
- Neutral and factual. No quotes of individual remarks.
- End with the source: kind, date and title, marked "(private)". For example, "from the 12 Nov roadmap meeting (private)".
- Only publish a decision as **agreed** if the source shows it was agreed. Otherwise publish it as **proposed**, or flag it.

## One source, written for each tier

A single meeting, carrying a date change, a capacity constraint and a
commercial reason. It becomes three items, not one.

> **Source (private):** the 12 Nov roadmap meeting. The release slips from
> 28 Nov to 5 Dec, because the client has not approved the change order for the
> upload rework, and because QA has one tester free this sprint rather than
> two. Someone also says the client's procurement lead is "dragging this out
> on purpose".

**Tier 3 — delivery**

> **Release moved to 5 Dec**
> The release date has moved from 28 Nov to 5 Dec. The upload rework is the
> item driving the date. From the 12 Nov roadmap meeting (private).
> *Left out: commercial, people.*

**Tier 2 — leads**

> **Release moved to 5 Dec; QA capacity is the constraint this sprint**
> The release has moved from 28 Nov to 5 Dec. One tester is available this
> sprint rather than two, which sets the pace of the upload rework; plan
> regression accordingly. From the 12 Nov roadmap meeting (private).
> *Left out: commercial.*

**Tier 1 — governance**

> **Release moved to 5 Dec, pending the upload change order**
> The release has moved from 28 Nov to 5 Dec. The upload rework is waiting on
> the client's approval of the change order; the date assumes approval this
> week. QA has one tester this sprint. From the 12 Nov roadmap meeting
> (private).
> *Left out: client relationship.*

Three things to notice.

**The date is at every tier.** The team needs it to work. What differs is how
much of the *reason* each tier gets: none at tier 3, the delivery constraint at
tier 2, the commercial dependency at tier 1.

**The remark about the procurement lead is at no tier.** It is a judgement
about a named person at the client, so it is left out of all three items and
recorded in the digest only as the category "client relationship". It is not
"tier 1 material"; it is not brain material.

**Each item stands on its own.** Someone at tier 2 reads the tier-2 item
without knowing a tier-1 version exists. So the tier-2 item has to be complete
and true by itself, not a redacted-looking version of something fuller.

### When one tier is enough

Most sources do not need three items. "The staging environment now runs
Postgres 16" is one tier-3 item and nothing else. Write the extra items only
when a tier genuinely needs detail the tier below must not have — a second item
that only repeats the first in longer words costs neurons and gives the reader
two things to read where one would do.

### When you are unsure

Give the item **tier 1 and flag it**. Moving an item down a tier later is a
click. Pulling it back up after the team has read it is not possible.


## Never published, whatever the content

These sources are screened out before the curator sees them:

- `em_tracker.worklog_shortfalls`;
- punctuality data;
- `em_tracker.member_notification_channels`;
- time entries at the level of an individual (team totals are fine);
- anything from another project.
