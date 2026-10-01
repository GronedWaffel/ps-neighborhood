ENTRY(_start)
SECTIONS {
  . = 0;
  .text : { *(.entry) *(.text*) *(.rodata*) }
  . = 0x10000;
  .data : { *(.mailbox) *(.data*) *(.bss*) }
  /DISCARD/ : { *(.eh_frame*) *(.comment*) *(.note*) }
}
