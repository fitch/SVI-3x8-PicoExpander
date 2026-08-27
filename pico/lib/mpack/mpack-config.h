/**
 * mpack configuration for SVI-3x8 PicoExpander
 *
 * Minimal config: writer + reader only, no malloc, no stdio.
 */

#ifndef MPACK_CONFIG_H
#define MPACK_CONFIG_H

#define MPACK_WRITER 1
#define MPACK_READER 1
#define MPACK_EXPECT 1
#define MPACK_NODE 0
#define MPACK_STDIO 0
#define MPACK_COMPATIBILITY 0

#endif /* MPACK_CONFIG_H */
