## MODIFIED Requirements

### Requirement: Cap what it returns
`read_file` SHALL return at most the first 32 KiB (32,768 bytes) of a file, cut back to the nearest UTF-8 character boundary. No character is longer than 4 bytes, so the cut SHALL move back at most 3 bytes. In invalid UTF-8 it stops there, and each broken byte reads as U+FFFD. When it cuts, a note SHALL follow, giving the number of bytes shown and the file's size in bytes.

#### Scenario: Small file
- **WHEN** the file is 1,000 bytes
- **THEN** the output is the whole file, with no note

#### Scenario: Large file
- **WHEN** the file is 40,000 bytes of ASCII text
- **THEN** the output is its first 32,768 bytes, followed by a note saying 32768 of 40000 bytes are shown

#### Scenario: Cut on a character boundary
- **WHEN** the file is 20,000 copies of "€", 3 bytes each and 60,000 bytes in all
- **THEN** the output is 10,922 copies of "€" (32,766 bytes) with no replacement character, followed by a note saying 32766 of 60000 bytes are shown

#### Scenario: A four-byte character at the cut
- **WHEN** the file is "a" and then 10,000 copies of "😀", 4 bytes each and 40,001 bytes in all
- **THEN** the output is "a" and 8,191 copies of "😀" (32,765 bytes) with no replacement character, followed by a note saying 32765 of 40001 bytes are shown

#### Scenario: Invalid UTF-8 at the cut
- **WHEN** the file is 32,760 bytes of ASCII text, then 20 bytes of 0x80, then 1,000 more bytes of ASCII text
- **THEN** the output is the 32,760 ASCII bytes and five U+FFFD characters, followed by a note saying 32765 of 33780 bytes are shown
