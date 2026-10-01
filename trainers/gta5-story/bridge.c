#ifndef GTA_BUILD_PROFILE_HEADER
#define GTA_BUILD_PROFILE_HEADER "build-profile.h"
#endif
#include GTA_BUILD_PROFILE_HEADER
// A single script-thread mailbox. No new console service or worker thread.
// The host attaches only to a verified native slot in main_persistent.
typedef unsigned long long u64;
typedef unsigned int u32;
typedef unsigned char u8;
typedef struct { float x, y, z, w; } Vec4;
typedef struct {
    u64 *result;
    u32 count, pad0;
    u64 *args;
    u32 vectors, pad1;
    float *dest[4];
    Vec4 temp[4];
} Context;
typedef void (*Native)(Context *);
typedef struct {
    u64 magic;
    u64 original;
    volatile u32 state;
    u32 count;
    u64 function;
    u64 args[32];
    u64 result[4];
    volatile u32 error;
    volatile u32 visits;
    u8 scratch[1024];
    volatile u32 frame_flags;
    u32 last_frame;
    u64 natives[20];
    u64 platform;
    float platform_top;
    volatile u32 menu_enabled;
    volatile u32 menu_ticks;
    volatile u32 menu_renders;
    volatile u32 menu_open;
    volatile u32 menu_job;
    volatile u32 job_elapsed;
    volatile u32 last_job_ms;
    volatile u32 selection;
    volatile u32 warm_model;
    volatile u32 warm_ready;
    u32 seed_version;
    u32 seed_flags[14];
} Mailbox;
__attribute__((section(".mailbox"), used, visibility("hidden")))
volatile Mailbox mailbox;

static u64 floating(float f) { union { float f; u32 i; } u; u.f = f; return u.i; }
static float as_float(u64 v) { union { float f; u32 i; } u; u.i = (u32)v; return u.f; }
static u64 call_small(u32 index, u32 count, u64 *args) {
    u64 result[4] = {0,0,0,0};
    Context context;
    context.result = result; context.count = count; context.pad0 = 0;
    context.args = args; context.vectors = context.pad1 = 0;
    ((Native)mailbox.natives[index])(&context);
    return result[0];
}
static void call_vector(u32 index, u32 count, u64 *args, u64 *result) {
    Context context;
    context.result = result; context.count = count; context.pad0 = 0;
    context.args = args; context.vectors = context.pad1 = 0;
    ((Native)mailbox.natives[index])(&context);
}

#include "menu.c"
_Static_assert(__builtin_offsetof(Mailbox, menu_enabled) == 0x5fc, "menu mailbox layout");

__attribute__((section(".entry"), used, visibility("hidden")))
void _start(Context *original_context) {
    mailbox.visits++;
    menu_tick();
    if (mailbox.frame_flags && *(volatile u8 *)GTA_NETWORK_FLAG == 0) {
        u64 root = *(volatile u64 *)GTA_PLAYER_ROOT;
        u64 player = root ? *(volatile u64 *)(root + 8) : 0;
        u64 info = player ? *(volatile u64 *)(player + 0x1088) : 0;
        if (info) {
            u32 bits = ((mailbox.frame_flags & 1) ? 0x4000 : 0) |
                       ((mailbox.frame_flags & 2) ? 0x800 : 0);
            *(volatile u32 *)(info + GTA_FRAME_FLAGS_OFFSET) |= bits;
        }
        if ((mailbox.frame_flags & 124) && mailbox.natives[0]) {
            u64 args[10];
            u32 frame = (u32)call_small(0, 0, args);
            if (frame != mailbox.last_frame) {
                mailbox.last_frame = frame;
                if (mailbox.frame_flags & 64) clear_wanted();
                if (mailbox.frame_flags & 16) {
                    args[0] = 0; args[1] = 27; args[2] = 1;
                    call_small(7, 3, args);
                }
                if (mailbox.frame_flags & 44) {
                    args[0] = call_small(1, 0, args); args[1] = 0;
                    u64 vehicle = call_small(2, 2, args);
                    if (vehicle) {
                        args[0] = vehicle;
                        if ((mailbox.frame_flags & 4) && call_small(3, 1, args)) {
                            args[0] = vehicle;
                            float speed = as_float(call_small(4, 1, args));
                            float delta = as_float(call_small(8, 0, args));
                            if (speed >= 0 && speed < 90 && delta > 0 && delta < 0.1f) {
                                args[0] = vehicle; args[1] = floating(speed + delta * 25);
                                call_small(5, 2, args);
                            }
                        }
                        if (mailbox.frame_flags & 8) {
                            args[0] = vehicle; args[1] = 1;
                            args[2] = args[3] = floating(0); args[4] = floating(-0.5f);
                            args[5] = 0; args[6] = 0; args[7] = 1; args[8] = 0;
                            call_small(6, 9, args);
                        }
                        if ((mailbox.frame_flags & 32) && mailbox.platform && mailbox.natives[10]) {
                            args[0] = mailbox.platform;
                            if (call_small(15, 1, args)) {
                                u64 position[4] = {0,0,0,0}; float water = 0;
                                args[0] = vehicle; args[1] = 0;
                                call_vector(10, 2, args, position);
                                args[0] = position[0]; args[1] = position[1]; args[2] = position[2];
                                args[3] = (u64)&water;
                                u64 wet = call_small(11, 4, args);
                                float z = as_float(position[2]);
                                args[0] = mailbox.platform; args[1] = position[0]; args[2] = position[1];
                                args[3] = floating((wet && z < water + 10 && z > water - 3) ? water + 0.10f - mailbox.platform_top : -200.0f);
                                args[4] = args[5] = args[6] = 0;
                                call_small(12, 7, args);
                                args[0] = vehicle;
                                u64 heading = call_small(13, 1, args);
                                args[0] = mailbox.platform; args[1] = heading;
                                call_small(14, 2, args);
                            }
                        }
                    }
                }
            }
        }
    }
    u32 expected = 1;
    if (mailbox.magic == 0x325654474e5350ULL &&
        __atomic_compare_exchange_n(&mailbox.state, &expected, 2, 0, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) {
        mailbox.error = 0;
        if (*(volatile u8 *)GTA_NETWORK_FLAG != 0) mailbox.error = 1;
        else if (mailbox.function < 0x400000 || mailbox.function >= GTA_EXEC_END || mailbox.count > 32) mailbox.error = 2;
        else {
            Context context;
            context.result = (u64 *)mailbox.result;
            context.count = mailbox.count;
            context.pad0 = 0;
            context.args = (u64 *)mailbox.args;
            context.vectors = context.pad1 = 0;
            for (u32 i = 0; i < 4; i++) { context.dest[i] = 0; mailbox.result[i] = 0; }
            ((Native)mailbox.function)(&context);
            if (context.vectors > 4) mailbox.error = 3;
            else for (u32 i = 0; i < context.vectors; i++) {
                if (context.dest[i]) {
                    context.dest[i][0] = context.temp[i].x;
                    context.dest[i][2] = context.temp[i].y;
                    context.dest[i][4] = context.temp[i].z;
                }
            }
        }
        __atomic_store_n(&mailbox.state, 3, __ATOMIC_RELEASE);
    }
    ((Native)mailbox.original)(original_context);
}
