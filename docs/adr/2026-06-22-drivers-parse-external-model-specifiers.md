# Drivers parse external model specifiers

Caara core will parse only the external agent kind prefix from the Codex `model` string and pass the
remaining external model specifier to the selected driver as opaque text. Drivers, not Caara core,
own model interpretation and validation because external harnesses may expose arbitrary or changing
model names that Caara cannot know in advance.
