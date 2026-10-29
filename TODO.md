# IssueFlow delivery checklist

## Accounts and access
- [ ] Add a real login screen with Google sign-in and a separate email/password account path.
- [ ] Keep sessions server-side and scope company data to the signed-in company.

## Company error tracking
- [ ] Remove the Roadmap navigation item.
- [ ] Replace the personal issue view with company error tracking for monthly errors.
- [ ] Let a signed-in user add, edit, filter, and resolve error records without the old issue-title field.
- [ ] Persist company errors and users in the managed database.

## Reporting and assistance
- [ ] Provide a monthly error report with totals, trends, severity, status, and top error sources.
- [ ] Add an automatic assistant action that analyzes an error and proposes a fix or marks safe cases resolved; never claim that source code was changed when it was not.

## Delivery
- [ ] Keep the project GitHub-ready with readable source and setup instructions.
- [ ] Start the project and verify authentication screens, error entry, report views, route manifest, and production build.
- [ ] Provide a live link when a successful publication is available.
