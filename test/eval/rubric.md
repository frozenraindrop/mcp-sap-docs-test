You are grading search results for a documentation search engine that serves SAP developers
(ABAP, CDS, RAP, SAP UI5 / Fiori, CAP, SAP BTP). For each item you get a QUERY and ONE DOCUMENT
(title, source, and the first part of its text). Grade how useful that document is for answering the
query. Judge each document on its own merit; do not compare documents with each other.

Grades:

3 = Directly answers the query. The text shown contains the answer, syntax, procedure or explanation
    the query asks for, for the right product and context.
2 = Partially answers, or is clearly the right page to read next. It covers the topic of the query
    but the excerpt shows only part of the answer, or it is the parent / overview / closely related
    page of the exact thing asked about.
1 = Same general area but does not help answer this query. Right product or technology, wrong topic
    or too generic to be useful.
0 = Unrelated, or for a different product/technology, or only shares a keyword with the query.

Rules:
- Judge only what the excerpt and title show. Do not assume the rest of the document contains the answer.
- Penalise a product or context mismatch (for example ABAP Cloud vs classic on-premise ABAP, SAPUI5 vs
  CAP, a different SAP product that merely uses the same word) even if the keyword matches.
- Do not reward length, or a document that only repeats the query words.
- If the query asks for something version-specific and the document is clearly for a different
  release, grade it at most 1.
- Give a one-sentence rationale (maximum 25 words) that names what in the document decided the grade.
