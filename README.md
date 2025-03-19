# Amazon Workers Comp tracker / Non work related TLD accoms, Version 0.1.2
## Contact Josh Baney @jnbaney on Slack or email jnbaney@amazon.com for info or troubleshooting. Most current version. 

A Node.js (Express) application to manage accommodations requests, track seated vs. non-seated TLD roles, integrate with Slack for notifications, and display a spreadsheet-like seat count for each shift.

---

## Features

1. **Accommodations Data**  
   - Store or update accommodations (new vs. existing)  
   - Capture shift pattern, job role, start/end dates, etc.

2. **TLD vs. Non-TLD Roles**  
   - “Asset tagging” and “Seated PA role” are counted as seated  
   - Other TLD and non-TLD roles remain stored but do not affect seat counts

3. **Status Updates**  
   - Mark an accommodation as Pending, Approved, or Expired  
   - Only Approved TLD roles count toward seat totals

4. **Slack Integration**  
   - When a new or updated accommodation is saved, a Slack webhook sends a formatted message with restrictions, recommendations, seat counts, and more

5. **Spreadsheet-Style Seat Counts**  
   - The front-end (active-accommodations.html) displays a day × shift code grid (FHD, FHN, BHD, BHN, FLEX) with seat totals for each day

6. **Auto-Fill Existing Records**  
   - If updating an existing request, the UI fetches and pre-fills the data for modification

---

## Project Structure

AmazonWCtracker/
├── .env                  # Environment variables (NOT in source control)
├── README.md             # This file
├── package.json          # Node.js dependencies and scripts
├── server.js             # Main Express server, Slack logic, DB queries
└── public/
    ├── style.css         # CSS for larger, rounder, centered UI
    ├── active-accommodations.html
    └── update-restrictions.html



---

## Installation

1. **Clone the Repository**  
   ```bash
   git clone https://github.com/YourUsername/AmazonWCtracker.git
   cd AmazonWCtracker
2. **Install Dependencies
 ```bash
npm install
```
- Installs packages such as Express, mysql2, node-fetch, dotenv, etc.
  
3. **Set Up the Database (MySQL/MariaDB)
- Create a database, for example myaccommodationsdb.
```bash
CREATE TABLE accommodations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  claimNumber VARCHAR(50) NOT NULL,
  associateLogin VARCHAR(50) NOT NULL,
  associateName VARCHAR(100),
  managerLogin VARCHAR(50),
  associateHomePath VARCHAR(50),
  shiftPattern VARCHAR(50),
  shiftType VARCHAR(10),
  site VARCHAR(10),
  requestingJobPath VARCHAR(100),
  requestorLogin VARCHAR(50),
  startDate DATE,
  endDate DATE,
  status VARCHAR(20) DEFAULT 'Pending',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
4. **Configure Environment Variables
- Create a .env file (excluded from version control). For example:
 ```bash
DB_HOST=localhost
DB_USER=root
DB_PASS=mysecret
DB_NAME=myaccommodationsdb

PORT=3000

SLACK_WEBHOOK_URL=https://hooks.slack.com/services/your/webhook/url
```
5. **Run the App
```bash
npm start
```
## Usage
1. **Update Restrictions Page
URL: /update-restrictions.html
Create a new request: Choose “Yes,” fill in full details (associate name/login, manager, shift pattern, claim #, etc.).
Update an existing request: Choose “No,” select an existing claim (auto-fills).
On submit, the app sets status to Pending (unless configured otherwise) and sends a Slack notification with your custom format.
2. **Active Accommodations Page
URL: /active-accommodations.html
Seat Counts Spreadsheet:
A day-by-day grid (Sunday–Saturday) for shift codes FHD, FHN, BHD, BHN, FLEX, showing the number of Approved TLD seated roles each day.
Automatically updates after any DB changes.
All Accommodations Table:
Shows each record’s ID, claim #, shift pattern, job path, and current status.
You can change status (Approved, Pending, Expired) or job path, then click Save to update the DB.
The seat count grid refreshes to reflect new totals.

## Slack Message Format
**When you create or update an accommodation, the Slack message is posted like:

```pgsql
We have received restrictions for [Associate Name] ([Associate Login])
@channel

Home Path: [Associate's Home Path]
Restrictions: [Associates Restrictions]
Recommendation: [Requesting Job path]

This is an automated message sent out by: [Requestor's login]

Current seated spots for [Shift_Count]:
Total Seated accommodations: [Seated_Total]
```

## Shifts & Days Logic
- **FHD: Sunday–Wednesday
- **FHN: Sunday–Wednesday nights
- **BHD: Wednesday–Saturday
- **BHN: Wednesday–Saturday nights
- **FLEX: stands alone
- **Shift pattern strings like DA, DB, DC, NA, NB, RT, RTN, etc., are parsed to determine the final shift code.
