// Resident Story Mode menu. Included by bridge.c; all work runs on the game's
// existing script thread. Streaming jobs advance once per frame, never WAIT.

#ifdef GTA_MENU_TEST
static u64 menu_test_native(u64 address, u32 count, u64 *args, u64 *out);
#endif
static u64 nc(u64 address, u32 count, u64 *args, u64 *out) {
#ifdef GTA_MENU_TEST
    return menu_test_native(address, count, args, out);
#else
    u64 local[4] = {0}, padded[32] = {0}; Context c = {0};
    if(count>32)return 0;
    for(u32 i=0;i<count;i++)padded[i]=args[i];
    c.result = out ? out : local; c.args = padded; c.count = count;
    ((Native)address)(&c);
    if (c.vectors <= 4) for (u32 i = 0; i < c.vectors; i++) if (c.dest[i]) {
        c.dest[i][0] = c.temp[i].x; c.dest[i][2] = c.temp[i].y; c.dest[i][4] = c.temp[i].z;
    }
    return c.result[0];
#endif
}
#define N(name, ...) nc(H_##name, sizeof((u64[]){0, ##__VA_ARGS__})/8-1, ((u64[]){0, ##__VA_ARGS__})+1, 0)
#define V(name, out, ...) nc(H_##name, sizeof((u64[]){0, ##__VA_ARGS__})/8-1, ((u64[]){0, ##__VA_ARGS__})+1, out)
#define F(x) floating((float)(x))
// Keep pointer-valued native arguments as runtime RIP-relative addresses.
// Folding a string argument into a static u64 initializer would leave its
// link-time address in this flat image, which can be allocated at any base.
static u64 native_pointer(const void *p){u64 address=(u64)p;__asm__ volatile("" : "+r"(address));return address;}
#define P(x) native_pointer(x)
enum { GOD, CLIP, AMMO, RUN, JUMP, WANTED, EXPLOSIVE, BELT, RADIO, PHONE, CAR_GOD, HORN, STICKY, WATER, TOGGLE_COUNT };
#include "vehicle-catalogue.h"
#include "clothing-labels.h"
static const char vehicle_classes[][24]={"Compacts","Sedans","SUVs","Coupes","Muscle cars","Sports classics","Sports cars","Supercars","Motorcycles","Off-road","Industrial","Utility","Vans","Bicycles","Boats & submarines","Helicopters","Planes & airships","Service","Emergency","Military","Commercial","Trains","Open-wheel racers"};
static struct {
    u32 frame, initialized, open, page, row, previous_keys, confirm, job, step, started, model;
    u32 flags[TOGGLE_COUNT], vehicle, vehicle_model, weapon, weather, hour, component, drawable, texture;
    u32 spawn, character, tick_count, renders, last_error, wanted_clears, last_ped, last_vehicle;
    float x, y; char notice[96]; u32 notice_until; u64 prologue_stack, prologue_thread, prologue_hash; u32 prologue_offset;
    u32 warm_model, warm_ready, warm_changed, warm_candidate, repeat_key, repeat_at, parent, parent_row;
    u32 last_job_ms, job_frame_start;
    float highlight;
    u32 scroll, history_count, history_page[6], history_row[6], history_scroll[6];
    char list_label[48];
    u32 warm_pins[3], warm_unavailable;
    u32 vehicle_scan, vehicle_total, vehicle_class, class_total;
    unsigned short available_vehicles[VEHICLE_CANDIDATES], class_first[23], class_count[23];
    u8 available_classes[23];
    u32 preview_active, preview_ped, preview_model, preview_slot;
    u32 preview_original_draw, preview_original_texture, preview_palette;
    u32 preview_applied_draw, preview_applied_texture, preview_row, preview_page, preview_changed;
    u32 preview_camera, preview_camera_enabled;
    char clothing_label[96], clothing_detail[96];
    u32 outfit_original[12][3], outfit_applied[12][3], outfit_owned;
    u32 teleport_scene,teleport_focus,teleport_ped,teleport_entity,teleport_model,teleport_stage_started,teleport_last_probe;
} menu;
static const char ped_names[][24] = {"player_zero","player_one","player_two","a_m_y_business_01","s_m_y_blackops_01","s_m_y_cop_01","u_m_y_imporage","a_c_chop"};
static const char ped_labels[][24] = {"Michael","Franklin","Trevor","Businessman","Black Ops soldier","Police officer","Impotent Rage","Chop"};
static const char component_labels[][24] = {"Head","Mask","Hair","Torso","Legs","Bags / parachutes","Shoes","Accessories","Undershirt","Body armor","Decals","Tops"};
static const u8 clothing_order[]={3,11,4,6,8,9,10,5,1,2,7,0};
static const char story_component_labels[][24]={"Face","Facial hair / masks","Hairstyles","Shirts / jackets","Trousers / shorts","Bags / gloves","Footwear","Extra accessories","Neckwear / accessories","Equipment / armor","Clothing logos","Vests / upper layers"};
static const char weather_names[][16] = {"EXTRASUNNY","CLEAR","CLOUDS","OVERCAST","RAIN","THUNDER","FOGGY","SMOG","CLEARING","SNOW","BLIZZARD","XMAS"};
static const char weapon_names[][32] = {"weapon_knife","weapon_nightstick","weapon_hammer","weapon_bat","weapon_crowbar","weapon_golfclub","weapon_bottle","weapon_dagger","weapon_hatchet","weapon_machete","weapon_switchblade","weapon_pistol","weapon_combatpistol","weapon_appistol","weapon_pistol50","weapon_snspistol","weapon_heavypistol","weapon_vintagepistol","weapon_revolver","weapon_microsmg","weapon_smg","weapon_assaultsmg","weapon_combatpdw","weapon_machinepistol","weapon_assaultrifle","weapon_carbinerifle","weapon_advancedrifle","weapon_specialcarbine","weapon_bullpuprifle","weapon_compactrifle","weapon_mg","weapon_combatmg","weapon_gusenberg","weapon_pumpshotgun","weapon_sawnoffshotgun","weapon_assaultshotgun","weapon_bullpupshotgun","weapon_heavyshotgun","weapon_dbshotgun","weapon_sniperrifle","weapon_heavysniper","weapon_marksmanrifle","weapon_rpg","weapon_grenadelauncher","weapon_minigun","weapon_hominglauncher","weapon_railgun","weapon_grenade","weapon_stickybomb","weapon_smokegrenade","weapon_molotov","weapon_proximine","weapon_fireextinguisher","weapon_petrolcan","gadget_parachute"};
static const char skill_names[][28] = {"STAMINA","SHOOTING_ABILITY","STRENGTH","STEALTH_ABILITY","FLYING_ABILITY","WHEELIE_ABILITY","LUNG_CAPACITY"};
static const char weapon_labels[][28] = {"Knife","Nightstick","Hammer","Baseball bat","Crowbar","Golf club","Bottle","Dagger","Hatchet","Machete","Switchblade","Pistol","Combat pistol","AP pistol","Pistol .50","SNS pistol","Heavy pistol","Vintage pistol","Heavy revolver","Micro SMG","SMG","Assault SMG","Combat PDW","Machine pistol","Assault rifle","Carbine rifle","Advanced rifle","Special carbine","Bullpup rifle","Compact rifle","MG","Combat MG","Gusenberg sweeper","Pump shotgun","Sawed-off shotgun","Assault shotgun","Bullpup shotgun","Heavy shotgun","Double-barrel shotgun","Sniper rifle","Heavy sniper","Marksman rifle","RPG","Grenade launcher","Minigun","Homing launcher","Railgun","Grenade","Sticky bomb","Tear gas","Molotov","Proximity mine","Fire extinguisher","Jerry can","Parachute"};
static void copy(char *to, const char *from, u32 max) { u32 i=0; for (; i+1<max && from[i]; i++) to[i]=from[i]; to[i]=0; }
static u32 hash(const char *s) { u32 h=0; for (; *s; s++) { u8 b=*s; if(b>='A'&&b<='Z') b+=32; h+=b; h+=h<<10; h^=h>>6; } h+=h<<3; h^=h>>11; return h+(h<<15); }
static u32 now(void) { return N(GET_GAME_TIMER); }
static void catalogue_tick(void) {
    u32 began=now();
    for(u32 work=0;menu.vehicle_scan<VEHICLE_CANDIDATES&&work<24;work++){
        u32 i=menu.vehicle_scan++,h=vehicle_catalogue[i].model,c=vehicle_catalogue[i].category;
        if(N(IS_MODEL_IN_CDIMAGE,h)&&N(IS_MODEL_VALID,h)&&N(IS_MODEL_A_VEHICLE,h)){
            if(!menu.class_count[c]){menu.class_first[c]=menu.vehicle_total;menu.available_classes[menu.class_total++]=c;}
            menu.class_count[c]++;menu.available_vehicles[menu.vehicle_total++]=i;
        }
        if(now()-began>=2)break;
    }
}
static u32 vehicle_index(u32 row) {
    if(menu.vehicle_class>=23||row>=menu.class_count[menu.vehicle_class])return VEHICLE_CANDIDATES;
    return menu.available_vehicles[menu.class_first[menu.vehicle_class]+row];
}
static u32 vehicle_hash(u32 row) {u32 i=vehicle_index(row);return i<VEHICLE_CANDIDATES?vehicle_catalogue[i].model:0;}
static void say(const char *s) { copy(menu.notice,s,sizeof(menu.notice)); menu.notice_until=now()+6000; }
static void number(char *s, u32 n) { char b[12]; u32 i=0,j=0; do {b[i++]='0'+n%10;n/=10;}while(n); while(i)s[j++]=b[--i];s[j]=0; }
static u32 ped(void) { return N(PLAYER_PED_ID); }
static u32 car(void) { return N(GET_VEHICLE_PED_IS_IN,ped(),0); }
static int protagonist(void) { u32 m=N(GET_ENTITY_MODEL,ped());for(u32 i=0;i<3;i++)if(m==hash(ped_names[i]))return i;return -1; }
static u32 stat(const char *suffix, u32 character) { char s[64]={'S','P','0'+character,'_',0};copy(s+4,suffix,60);return hash(s); }
static void append(char *s,const char *v,u32 limit){u32 i=0;while(i<limit&&s[i])i++;if(i<limit)copy(s+i,v,limit-i);}
static void append_number(char *s,u32 n,u32 limit){char b[12];number(b,n);append(s,b,limit);}
static const char *component_name(u32 slot){return protagonist()>=0?story_component_labels[slot]:component_labels[slot];}
static void story_clothing_key(char *key,u32 character,u32 slot,u32 draw,u32 texture){
    key[0]=0;
    const char *prefix=slot==1?"BERD":slot==2?"HAIR":slot==3?"TORSO":slot==4?"LEGS":slot==6?"FEET":slot==8?"SPEC":slot==10?"DECL":slot==11?"JBIB":0;
    if(!prefix)return;
    for(u32 i=0;i<sizeof(story_clothing_labels)/sizeof(story_clothing_labels[0]);i++){
        const signed char *v=story_clothing_labels[i];
        if(v[0]!=character||v[1]!=slot||v[2]!=draw||texture<(u32)v[3]||texture>(u32)v[4])continue;
        copy(key,prefix,64);append(key,"_P",64);append_number(key,character,64);append(key,"_",64);append_number(key,v[5],64);append(key,"_",64);append_number(key,(int)texture+v[6],64);return;
    }
}
static const char *clothing_name(u32 drawable,u32 texture) {
    char key[64]={0};int character=protagonist();
    if(character>=0)story_clothing_key(key,character,menu.component,drawable,texture);
    else {
        u32 h=N(GET_HASH_NAME_FOR_COMPONENT,ped(),menu.component,drawable,texture);
        if(h){u64 data[20]={0};N(GET_SHOP_PED_COMPONENT,h,P(data));copy(key,(const char*)data+72,64);}
    }
    if(key[0]&&N(DOES_TEXT_LABEL_EXIST,P(key))){const char *s=(const char*)N(GET_FILENAME_FOR_AUDIO_CONVERSATION,P(key));if(s&&s[0]){copy(menu.clothing_label,s,96);return menu.clothing_label;}}
    if(character>=0&&menu.component==11&&drawable==0)return "No upper layer";
    copy(menu.clothing_label,component_name(menu.component),96);append(menu.clothing_label," #",96);append_number(menu.clothing_label,drawable,96);
    if(menu.page==13){append(menu.clothing_label," / texture ",96);append_number(menu.clothing_label,texture,96);}return menu.clothing_label;
}
static void outfit_snapshot(u32 p){
    for(u32 i=0;i<12;i++){
        menu.outfit_original[i][0]=menu.outfit_applied[i][0]=N(GET_PED_DRAWABLE_VARIATION,p,i);
        menu.outfit_original[i][1]=menu.outfit_applied[i][1]=N(GET_PED_TEXTURE_VARIATION,p,i);
        menu.outfit_original[i][2]=menu.outfit_applied[i][2]=N(GET_PED_PALETTE_VARIATION,p,i);
    }menu.outfit_owned=0;
}
static void outfit_set(u32 p,u32 slot,u32 draw,u32 texture,u32 palette){
    if(draw>=N(GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS,p,slot)||texture>=N(GET_NUMBER_OF_PED_TEXTURE_VARIATIONS,p,slot,draw))return;
    N(SET_PED_COMPONENT_VARIATION,p,slot,draw,texture,palette);
    menu.outfit_applied[slot][0]=draw;menu.outfit_applied[slot][1]=texture;menu.outfit_applied[slot][2]=palette;menu.outfit_owned|=1u<<slot;
}
static void outfit_restore(void){
    // Each layer is restored only while it still matches the preview we wrote.
    for(u32 i=0;i<12;i++)if(menu.outfit_owned&(1u<<i)){
        if(N(GET_PED_DRAWABLE_VARIATION,menu.preview_ped,i)==menu.outfit_applied[i][0]&&N(GET_PED_TEXTURE_VARIATION,menu.preview_ped,i)==menu.outfit_applied[i][1]&&N(GET_PED_PALETTE_VARIATION,menu.preview_ped,i)==menu.outfit_applied[i][2])
            N(SET_PED_COMPONENT_VARIATION,menu.preview_ped,i,menu.outfit_original[i][0],menu.outfit_original[i][1],menu.outfit_original[i][2]);
    }menu.outfit_owned=0;
}
static void outfit_apply(u32 p,u32 slot,u32 draw,u32 texture){
    outfit_restore();
    int character=protagonist();
    if(character>=0&&(slot==3||slot==11)){
        outfit_set(p,8,0,0,0);outfit_set(p,9,0,0,0);outfit_set(p,10,0,0,0);
        if(slot==3){
            u32 upper=0,colour=0;
            // Franklin's shirt cuts with matching vest/sleeve components.
            if(character==1){if(draw==4)upper=8;else if(draw==22)upper=7;else if(draw==18||draw==23)upper=3;else if(draw==24){upper=1;colour=texture/4;}}
            outfit_set(p,11,upper,colour,0);
        }else if(character==1&&draw){
            u32 shirt=18,colour=0;
            if(draw==1||draw==2){shirt=24;colour=texture*4;}else if(draw==7)shirt=22;else if(draw==8)shirt=4;else if(draw==10)shirt=21;
            outfit_set(p,3,shirt,colour,0);
        }
    }
    outfit_set(p,slot,draw,texture,0);
    menu.preview_applied_draw=draw;menu.preview_applied_texture=texture;
}
static void preview_camera_stop(void) {
    if(!menu.preview_camera)return;
    if((u32)N(GET_RENDERING_CAM)==menu.preview_camera)N(RENDER_SCRIPT_CAMS,0,1,150,1,0,0);
    N(DESTROY_CAM,menu.preview_camera,0);menu.preview_camera=0;
}
static void preview_end(void) {
    if(menu.preview_active&&N(DOES_ENTITY_EXIST,menu.preview_ped)&&N(GET_ENTITY_MODEL,menu.preview_ped)==menu.preview_model){
        outfit_restore();
    }
    preview_camera_stop();menu.preview_active=0;
}
static void preview_begin(u32 p,u32 slot) {
    preview_end();outfit_snapshot(p);menu.preview_active=1;menu.preview_ped=p;menu.preview_model=N(GET_ENTITY_MODEL,p);menu.preview_slot=slot;
    menu.preview_original_draw=menu.preview_applied_draw=N(GET_PED_DRAWABLE_VARIATION,p,slot);
    menu.preview_original_texture=menu.preview_applied_texture=N(GET_PED_TEXTURE_VARIATION,p,slot);
    menu.preview_palette=N(GET_PED_PALETTE_VARIATION,p,slot);menu.preview_row=menu.preview_page=0xffffffffu;menu.preview_changed=now();menu.preview_camera_enabled=1;
}
static void preview_commit(u32 drawable,u32 texture){
    if(!menu.preview_active)return;
    for(u32 i=0;i<12;i++)for(u32 j=0;j<3;j++)if(menu.outfit_owned&(1u<<i))menu.outfit_original[i][j]=menu.outfit_applied[i][j];
    menu.preview_original_draw=menu.preview_applied_draw=drawable;menu.preview_original_texture=menu.preview_applied_texture=texture;menu.preview_palette=0;
}
static void preview_tick(void) {
    if(!menu.preview_active)return;
    u32 p=ped();
    if(!menu.open||(menu.page!=12&&menu.page!=13)||p!=menu.preview_ped||N(GET_ENTITY_MODEL,p)!=menu.preview_model||menu.component!=menu.preview_slot){preview_end();return;}
    if(menu.preview_row!=menu.row||menu.preview_page!=menu.page){menu.preview_row=menu.row;menu.preview_page=menu.page;menu.preview_changed=now();}
    u32 d=menu.page==12?menu.row:menu.drawable,t=menu.page==13?menu.row:0;
    if(now()-menu.preview_changed>=120&&(d!=menu.preview_applied_draw||t!=menu.preview_applied_texture)&&d<N(GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS,p,menu.component)&&t<N(GET_NUMBER_OF_PED_TEXTURE_VARIATIONS,p,menu.component,d)){
        outfit_apply(p,menu.component,d,t);
    }
    if(!menu.preview_camera_enabled||car()||N(IS_CUTSCENE_ACTIVE)){preview_camera_stop();return;}
    if(menu.preview_camera&&(u32)N(GET_RENDERING_CAM)!=menu.preview_camera){preview_camera_stop();menu.preview_camera_enabled=0;return;}
    if(!menu.preview_camera){
        if(!N(IS_GAMEPLAY_CAM_RENDERING))return;
        menu.preview_camera=N(CREATE_CAM,P("DEFAULT_SCRIPTED_CAMERA"),1);if(!menu.preview_camera)return;
        N(SET_CAM_FOV,menu.preview_camera,F(50));
    }
    float distance=3.2f,height=.45f,focus=.25f;
    if(menu.component==0||menu.component==1||menu.component==2){distance=1.5f;height=.65f;focus=.65f;}
    if(menu.component==6){distance=1.5f;height=-.35f;focus=-.65f;}
    u64 point[4]={0};V(GET_OFFSET_FROM_ENTITY_IN_WORLD_COORDS,point,p,F(-.4f),F(distance),F(height));
    N(SET_CAM_COORD,menu.preview_camera,point[0],point[1],point[2]);N(POINT_CAM_AT_ENTITY,menu.preview_camera,p,F(0),F(0),F(focus),1);
    N(RENDER_SCRIPT_CAMS,1,0,0,1,0,0);
}
static u32 protect_spawned_vehicle(u32 v){
    if(!N(DECOR_IS_REGISTERED_AS_TYPE,P("MPBitset"),3))return 0;
    u32 flags=N(DECOR_EXIST_ON,v,P("MPBitset"))?N(DECOR_GET_INT,v,P("MPBitset")):0;
    if(!(flags&0x40000000u)&&!N(DECOR_SET_INT,v,P("MPBitset"),flags|0x40000000u))return 0;
    return (N(DECOR_GET_INT,v,P("MPBitset"))&0x40000000u)!=0;
}
static void text(float x,float y,float size,const char *s,u32 green) {
    N(SET_TEXT_FONT,0);N(SET_TEXT_SCALE,F(0),F(size));N(SET_TEXT_COLOUR,green?105:238,green?235:242,green?177:240,255);
    N(SET_TEXT_CENTRE,0);N(SET_TEXT_RIGHT_JUSTIFY,0);N(SET_TEXT_WRAP,F(0),F(1));N(SET_TEXT_OUTLINE);
    N(BEGIN_TEXT_COMMAND_DISPLAY_TEXT,P("STRING"));N(ADD_TEXT_COMPONENT_SUBSTRING_PLAYER_NAME,P(s));N(END_TEXT_COMMAND_DISPLAY_TEXT,F(x),F(y),0);
}
static void rect(float x,float y,float w,float h,u32 r,u32 g,u32 b,u32 a) { N(DRAW_RECT,F(x),F(y),F(w),F(h),r,g,b,a,0); }
#define ITEMS(a) (sizeof(a)/sizeof((a)[0]))
static const char *title(u32 page) { switch(page){case 1:return "PLAYER";case 2:return "WEAPONS";case 3:return "GARAGE";case 4:return "VEHICLE SPAWNER";case 5:return "WORLD";case 6:return "CHARACTER";case 7:return "STORY & PROGRESSION";case 8:return "WEAPON CATALOGUE";case 9:return "WEATHER";case 10:return "PLAYER MODELS";case 11:return "CLOTHING & OUTFITS";case 12:return "CLOTHING ITEMS";case 13:return "COLORS / TEXTURES";case 14:return "TIME OF DAY";case 15:return vehicle_classes[menu.vehicle_class];default:return "STORY MODE";} }
static u32 rows(void) {switch(menu.page){case 1:return 9;case 2:return 5;case 3:return 8;case 4:return menu.class_total?menu.class_total:1;case 15:return menu.class_count[menu.vehicle_class]?menu.class_count[menu.vehicle_class]:1;case 5:return 3;case 6:return 2;case 7:return 5;case 8:return ITEMS(weapon_names);case 9:return ITEMS(weather_names);case 10:return ITEMS(ped_names);case 11:return ITEMS(component_labels);case 12:{u32 n=N(GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS,ped(),menu.component);return n&&n<4096?n:1;}case 13:{u32 n=N(GET_NUMBER_OF_PED_TEXTURE_VARIATIONS,ped(),menu.component,menu.drawable);return n&&n<4096?n:1;}case 14:return 24;default:return 8;}}
static void scroll_to_selection(void) {
    u32 n=rows();if(menu.row>=n)menu.row=n-1;
    u32 old=menu.scroll;
    if(menu.row<menu.scroll)menu.scroll=menu.row;
    if(menu.row>=menu.scroll+9)menu.scroll=menu.row-8;
    if(n<=9)menu.scroll=0;else if(menu.scroll>n-9)menu.scroll=n-9;
    if(old!=menu.scroll)menu.highlight=menu.row-menu.scroll;
}
static void enter_page(u32 page,u32 selected) {
    if(menu.history_count>=6)return;
    u32 i=menu.history_count++;menu.history_page[i]=menu.page;menu.history_row[i]=menu.row;menu.history_scroll[i]=menu.scroll;
    menu.page=page;menu.row=selected;menu.scroll=0;scroll_to_selection();menu.highlight=menu.row-menu.scroll;
}
static void back_page(void) {
    if(!menu.history_count){menu.page=menu.row=menu.scroll=0;menu.highlight=0;return;}
    u32 i=--menu.history_count;menu.page=menu.history_page[i];menu.row=menu.history_row[i];menu.scroll=menu.history_scroll[i];scroll_to_selection();menu.highlight=menu.row-menu.scroll;
}
static int toggle_at(u32 page,u32 row) {
    if(page==1){switch(row){case 0:return GOD;case 1:return WANTED;case 2:return RUN;case 3:return JUMP;case 4:return BELT;case 5:return RADIO;case 6:return PHONE;}}
    if(page==2&&row<3)return row==0?CLIP:row==1?AMMO:EXPLOSIVE;
    if(page==3){switch(row){case 0:return CAR_GOD;case 2:return HORN;case 3:return STICKY;case 4:return WATER;}}
    return -1;
}
static const char *label(u32 row) {
    switch(menu.page){
    case 0:switch(row){case 0:return "Player";case 1:return "Weapons";case 2:return "Garage";case 3:return "Vehicle spawner";case 4:return "World";case 5:return "Character";case 6:return "Story & progression";default:return "Close menu";}
    case 1:switch(row){case 0:return "God mode";case 1:return "Never wanted";case 2:return "Super run (1.49x)";case 3:return "Super jump";case 4:return "Seatbelt";case 5:return "Walking radio";case 6:return "Phone off";case 7:return "Heal player";default:return "Clear wanted level now";}
    case 2:switch(row){case 0:return "Infinite clip";case 1:return "Infinite ammo";case 2:return "Explosive ammo";case 3:return "Weapon catalogue";default:return "Give all weapons";}
    case 3:switch(row){case 0:return "Vehicle god mode";case 1:return "Max performance upgrades";case 2:return "Horn boost";case 3:return "Stick vehicle to ground";case 4:return "Drive on water";case 5:return "Repair vehicle";case 6:return "Upright vehicle";default:return "Vehicle spawner";}
    case 4:return row<menu.class_total?vehicle_classes[menu.available_classes[row]]:"Preparing catalogue...";
    case 15:{u32 i=vehicle_index(row);return i<VEHICLE_CANDIDATES?vehicle_text+vehicle_catalogue[i].label:"No available vehicles";}
    case 5:return row==0?"Teleport to waypoint":row==1?"Weather presets":"Time of day";
    case 6:return row==0?"Player models":"Clothing & outfits";
    case 8:return weapon_labels[row];
    case 9:return weather_names[row];
    case 10:return ped_labels[row];
    case 11:return component_name(clothing_order[row]);
    case 12:case 13:return clothing_name(menu.page==12?row:menu.drawable,menu.page==13?row:0);
    case 14:number(menu.list_label,row);{u32 i=0;while(menu.list_label[i])i++;copy(menu.list_label+i,":00",48-i);}return menu.list_label;
    default:switch(row){case 0:return "+ $10,000,000";case 1:return "Max skills";case 2:return "Drop $10,000 cash";case 3:return "All achievement requests";default:return "Finish Prologue";}
    }
}
static void frame_flag(u32 bit,u32 enabled){if(enabled)mailbox.frame_flags|=bit;else mailbox.frame_flags&=~bit;}
static void clear_wanted(void){N(CLEAR_PLAYER_WANTED_LEVEL,0);menu.wanted_clears++;}
static void job_tick(void);
static void run_job(void);
static void release_warm(void) {
    for(u32 i=0;i<3;i++)if(menu.warm_pins[i]){
        if(!(menu.job>=1&&menu.job<=4&&menu.model==menu.warm_pins[i]))N(SET_MODEL_AS_NO_LONGER_NEEDED,menu.warm_pins[i]);
        menu.warm_pins[i]=0;
    }
    menu.warm_model=menu.warm_ready=menu.warm_unavailable=0;
}
static void prefetch_tick(void) {
    u32 candidate=menu.open&&menu.page==15?vehicle_hash(menu.row):menu.open&&menu.page==10?hash(ped_names[menu.row]):0;
    if(candidate!=menu.warm_candidate){menu.warm_candidate=candidate;menu.warm_ready=menu.warm_unavailable=0;menu.warm_changed=now();}
    if(!candidate){release_warm();return;}
    // An adjacent, already-pinned choice is usable immediately. Debounce only
    // new requests, so holding the D-pad does not flood the streaming queue.
    for(u32 i=0;i<3;i++)if(menu.warm_pins[i]==candidate){menu.warm_model=candidate;menu.warm_ready=N(HAS_MODEL_LOADED,candidate)!=0;}
    if(now()-menu.warm_changed<100)return;
    if(!N(IS_MODEL_IN_CDIMAGE,candidate)||!N(IS_MODEL_VALID,candidate)){
        release_warm();menu.warm_unavailable=1;return;
    }
    u32 wanted[3]={candidate,0,0};
    if(menu.page==15){u32 n=menu.class_count[menu.vehicle_class];if(n){wanted[1]=vehicle_hash((menu.row+1)%n);wanted[2]=vehicle_hash((menu.row+n-1)%n);}}
    for(u32 i=0;i<3;i++)if(menu.warm_pins[i]){
        u32 keep=0;for(u32 j=0;j<3;j++)if(menu.warm_pins[i]==wanted[j])keep=1;
        if(!keep){if(!(menu.job>=1&&menu.job<=4&&menu.model==menu.warm_pins[i]))N(SET_MODEL_AS_NO_LONGER_NEEDED,menu.warm_pins[i]);menu.warm_pins[i]=0;}
    }
    // Request the selected model first, then just its two immediate neighbours.
    for(u32 j=0;j<3;j++)if(wanted[j]){
        u32 held=0;for(u32 i=0;i<3;i++)if(menu.warm_pins[i]==wanted[j])held=1;
        if(!held&&N(IS_MODEL_IN_CDIMAGE,wanted[j])&&N(IS_MODEL_VALID,wanted[j])){
            for(u32 i=0;i<3;i++)if(!menu.warm_pins[i]){menu.warm_pins[i]=wanted[j];N(REQUEST_MODEL,wanted[j]);break;}
        }
    }
    menu.warm_model=candidate;menu.warm_unavailable=0;
    menu.warm_ready=N(HAS_MODEL_LOADED,candidate)!=0;
    if(!menu.warm_ready)N(REQUEST_MODEL,candidate);
}
static void begin_model_hash(u32 job,u32 h) {
    if(!N(IS_MODEL_IN_CDIMAGE,h)||!N(IS_MODEL_VALID,h)||(job==1&&!N(IS_MODEL_A_VEHICLE,h))||(job==2&&!N(IS_MODEL_A_PED,h))){say("Model not registered; check installed DLC packs");return;}
    menu.model=h;menu.job=job;menu.started=now();N(REQUEST_MODEL,h);say("Loading selected model...");
}
static void begin_model(u32 job,const char *name) {begin_model_hash(job,hash(name));}
static void toggle(u32 id) {
    u32 on=menu.flags[id]^1;menu.flags[id]=on;u32 p=ped();
    switch(id){
    case GOD:N(SET_ENTITY_INVINCIBLE,p,on);break;
    case RUN:N(SET_RUN_SPRINT_MULTIPLIER_FOR_PLAYER,0,F(on?1.49f:1.0f));break;
    case JUMP:frame_flag(1,on);break;
    case EXPLOSIVE:frame_flag(2,on);break;
    case HORN:frame_flag(4,on);break;
    case STICKY:frame_flag(8,on);break;
    case PHONE:frame_flag(16,on);if(on)N(DESTROY_MOBILE_PHONE);break;
    case WANTED:frame_flag(64,on);if(on)clear_wanted();break;
    case BELT:N(SET_PED_CONFIG_FLAG,p,32,!on);N(SET_PED_CAN_BE_KNOCKED_OFF_VEHICLE,p,on?1:0);break;
    case RADIO:N(SET_MOBILE_RADIO_ENABLED_DURING_GAMEPLAY,on);break;
    case CAR_GOD:{u32 v=car();if(v){N(SET_ENTITY_INVINCIBLE,v,on);N(SET_VEHICLE_TYRES_CAN_BURST,v,!on);N(SET_VEHICLE_CAN_BREAK,v,!on);}else say("Applies when you enter a vehicle");break;}
    case WATER:if(on){begin_model(4,"prop_container_ld2");if(menu.job!=4)menu.flags[id]=0;}else{frame_flag(32,0);u32 object=mailbox.platform;mailbox.platform=0;if(object&&N(DOES_ENTITY_EXIST,object))N(DELETE_OBJECT,P(&object));}break;
    default:break;
    }
}
static void teleport_cleanup(void){
    if(menu.teleport_scene){N(NEW_LOAD_SCENE_STOP);menu.teleport_scene=0;}
    if(menu.teleport_focus){N(CLEAR_FOCUS);menu.teleport_focus=0;}
}
static void teleport_finish(const char *message){teleport_cleanup();menu.job=0;say(message);}
static u32 teleport_stage(void){
    float height=200.0f+400.0f*menu.step;
    if(menu.teleport_scene){N(NEW_LOAD_SCENE_STOP);menu.teleport_scene=0;}
    N(SET_FOCUS_POS_AND_VEL,F(menu.x),F(menu.y),F(height),F(0),F(0),F(0));menu.teleport_focus=1;
    menu.teleport_scene=N(NEW_LOAD_SCENE_START_SPHERE,F(menu.x),F(menu.y),F(height),F(400),0)!=0;
    menu.teleport_stage_started=now();menu.teleport_last_probe=now()-100;
    return menu.teleport_scene;
}
static void teleport_start(u32 p,u32 v){
    u32 blip=N(GET_FIRST_BLIP_INFO_ID,8);
    if(!blip||!N(DOES_BLIP_EXIST,blip)){say("Set a waypoint first");return;}
    if(N(IS_NEW_LOAD_SCENE_ACTIVE)||N(IS_CUTSCENE_ACTIVE)){say("Game is loading a scene; try after it finishes");return;}
    u64 xyz[4]={0};V(GET_BLIP_INFO_ID_COORD,xyz,blip);menu.x=as_float(xyz[0]);menu.y=as_float(xyz[1]);
    if(!(menu.x>-12000&&menu.x<12000&&menu.y>-12000&&menu.y<12000)){say("Invalid waypoint coordinates");return;}
    menu.teleport_ped=p;menu.teleport_entity=v?v:p;menu.teleport_model=N(GET_ENTITY_MODEL,menu.teleport_entity);
    menu.step=0;menu.started=now();menu.job=7;
    if(!teleport_stage()){teleport_finish("Destination streaming could not start; try again");return;}
    say("Streaming waypoint terrain...");
}
static void teleport_tick(u32 p){
    u32 v=p?car():0;
    if(p!=menu.teleport_ped||!N(DOES_ENTITY_EXIST,menu.teleport_entity)||N(GET_ENTITY_MODEL,menu.teleport_entity)!=menu.teleport_model||(v?v:p)!=menu.teleport_entity||N(IS_CUTSCENE_ACTIVE)){
        teleport_finish("Character or vehicle changed; teleport stopped");return;
    }
    if(menu.step==3){if(now()-menu.teleport_stage_started>=350)teleport_finish("Teleported to waypoint");return;}
    if(!N(IS_NEW_LOAD_SCENE_ACTIVE)){teleport_finish("Destination streaming interrupted; try again");return;}
    if(now()-menu.teleport_last_probe>=100){
        menu.teleport_last_probe=now();float height=200.0f+400.0f*menu.step,z=0;
        N(REQUEST_COLLISION_AT_COORD,F(menu.x),F(menu.y),F(height));
        if(N(IS_NEW_LOAD_SCENE_LOADED)&&N(GET_GROUND_Z_FOR_3D_COORD,F(menu.x),F(menu.y),F(1500),P(&z),0,0)&&z>-200&&z<1500){
            N(SET_ENTITY_COORDS_NO_OFFSET,menu.teleport_entity,F(menu.x),F(menu.y),F(z+1),0,0,0);
            menu.step=3;menu.teleport_stage_started=now();say("Waypoint reached; settling terrain...");return;
        }
    }
    if(now()-menu.teleport_stage_started>=5000){
        if(++menu.step>=3){teleport_finish("No land at waypoint; choose a nearby road");return;}
        if(!teleport_stage())teleport_finish("Destination streaming could not restart");
    }
}
static void activate(u32 confirmed) {
    u32 p=ped(),v=car(),r=menu.row;
    if(!p){say("Character not ready");return;}
    if(menu.page==0){if(r==7)menu.open=0;else enter_page(r+1,0);return;}
    int id=toggle_at(menu.page,r);
    // Simple toggles remain responsive while a model is streaming. Water owns
    // an object-loading job, so it shares the single streaming queue.
    if(id>=0&&id!=WATER){toggle(id);return;}
    if(menu.page==3&&r==7){enter_page(4,0);return;}
    if(menu.page==2&&r==3){enter_page(8,0);return;}
    if(menu.page==5&&r>0){enter_page(r==1?9:14,r==1?menu.weather:menu.hour);return;}
    if(menu.page==6){enter_page(r==0?10:11,r==0?menu.character:0);return;}
    if(menu.job){say("An action is loading. Other toggles still work.");return;}
    if((menu.page==7||menu.page==10)&&!confirmed){menu.confirm=1;return;}
    if(id>=0){toggle(id);return;}
    menu.started=now();
    if(menu.page==1){if(r==7){u32 health=N(GET_ENTITY_MAX_HEALTH,p);N(SET_ENTITY_HEALTH,p,health,0,0);}else clear_wanted();}
    if(menu.page==2&&r==4){menu.job=5;menu.step=0;say("Giving weapon catalogue...");}
    if(menu.page==3){
        if(!v){say("Enter a vehicle first");return;}
        if(r==1){if((int)N(GET_NUM_MOD_KITS,v)<=0){say("This vehicle has no upgrade kit");return;}if(N(GET_VEHICLE_MOD_KIT,v)!=0)N(SET_VEHICLE_MOD_KIT,v,0);menu.vehicle=v;menu.vehicle_model=N(GET_ENTITY_MODEL,v);menu.job=6;menu.step=0;say("Checking performance upgrades...");}
        if(r==5){N(SET_VEHICLE_FIXED,v);N(SET_VEHICLE_DEFORMATION_FIXED,v);say("Vehicle repaired");}
        if(r==6){u64 heading=N(GET_ENTITY_HEADING,v);N(SET_ENTITY_ROTATION,v,F(0),F(0),heading,2,1);N(SET_VEHICLE_ON_GROUND_PROPERLY,v,F(5));}
    }
    if(menu.page==4){if(menu.vehicle_scan<VEHICLE_CANDIDATES){say("Preparing available vehicles...");return;}if(r<menu.class_total){menu.vehicle_class=menu.available_classes[r];enter_page(15,0);}return;}
    if(menu.page==15){u32 h=vehicle_hash(r);if(h){menu.spawn=r;begin_model_hash(1,h);}else say("No available vehicle selected");}
    if(menu.page==8){u32 h=hash(weapon_names[r]);if(N(IS_WEAPON_VALID,h)){N(GIVE_WEAPON_TO_PED,p,h,9999,0,1);say("Selected weapon given and equipped");}else say("This weapon is unavailable in your build");}
    if(menu.page==9){menu.weather=r;N(SET_WEATHER_TYPE_NOW_PERSIST,P(weather_names[r]));say("Weather applied");}
    if(menu.page==14){menu.hour=r;N(SET_CLOCK_TIME,r,0,0);say("Time applied");}
    if(menu.page==10){menu.character=r;begin_model(2,ped_names[r]);}
    if(menu.page==11){
        r=clothing_order[r];
        if(!N(GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS,p,r)){say("This character has no clothing for that slot");return;}
        menu.component=r;preview_begin(p,r);menu.drawable=menu.preview_original_draw;menu.texture=menu.preview_original_texture;enter_page(12,menu.drawable);return;
    }
    if(menu.page==12||menu.page==13){
        if(menu.page==12){menu.drawable=r;menu.texture=0;}else menu.texture=r;
        u32 count=N(GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS,p,menu.component);
        if(menu.drawable>=count){say("No clothing choices for this slot");return;}
        u32 textures=N(GET_NUMBER_OF_PED_TEXTURE_VARIATIONS,p,menu.component,menu.drawable);
        if(menu.texture>=textures){say("No textures for this clothing item");return;}
        outfit_apply(p,menu.component,menu.drawable,menu.texture);preview_commit(menu.drawable,menu.texture);say("Outfit kept");
        if(menu.page==12&&textures>1){enter_page(13,0);say("Clothing applied. Choose its color / texture.");}
    }
    if(menu.page==5){if(r==1){N(SET_WEATHER_TYPE_NOW_PERSIST,P(weather_names[menu.weather]));say("Weather applied");}if(r==2){N(SET_CLOCK_TIME,menu.hour,0,0);say("Time applied");}if(r==0)teleport_start(p,v);}

    if(menu.page==7){
        if(r<2){int c=protagonist();if(c<0){say("Switch to a story protagonist first");return;}if(r==0){int cash=0;u32 h=stat("TOTAL_CASH",c);if(!N(STAT_GET_INT,h,P(&cash),(u64)-1)||cash<0){say("Cannot read current balance");return;}u32 total=cash>2137483647?2147483647:cash+10000000;if(N(STAT_SET_INT,h,total,1))say("$10 million added (balance capped)");else say("Game rejected balance update");}else{menu.job=8;menu.step=0;menu.character=c;say("Updating skills...");}}
        if(r==2)begin_model(3,"prop_money_bag_01");
        if(r==3){menu.job=9;menu.step=1;say("Requesting achievements; game may reject IDs");}
        if(r==4){menu.job=10;menu.step=0;menu.prologue_offset=0;menu.prologue_hash=14695981039346656037ULL;say("Validating exact Prologue script...");}
    }
}
static void job_tick(void) {
    u32 p=ped();if(!p){if(menu.job==7)teleport_finish("Character unavailable; teleport stopped");return;}
    if(menu.job>=1&&menu.job<=4){
        u32 job=menu.job,h=menu.model;
        if(now()-menu.started>15000){N(SET_MODEL_AS_NO_LONGER_NEEDED,h);menu.job=0;if(job==4)menu.flags[WATER]=0;say("Model streaming timed out");return;}
        if(!N(HAS_MODEL_LOADED,h))return;
        u64 point[4]={0};V(GET_OFFSET_FROM_ENTITY_IN_WORLD_COORDS,point,p,F(0),F(job==1?6:2),F(1));
        if(job==1){u64 heading=N(GET_ENTITY_HEADING,p);u32 v=N(CREATE_VEHICLE,h,point[0],point[1],point[2],heading,0,0,0);if(v&&N(DOES_ENTITY_EXIST,v)){
            // The verified shop_controller excludes MPBitset bit 30 before
            // CLEAR_PED_TASKS_IMMEDIATELY and DELETE_VEHICLE. Tag this car before
            // seating the player, without changing global shop/mission logic.
            if(protect_spawned_vehicle(v)){N(SET_VEHICLE_ON_GROUND_PROPERLY,v,F(5));N(SET_PED_INTO_VEHICLE,p,v,(u64)-1);say("Vehicle spawned - Story cleanup protection set");}
            else{N(DELETE_VEHICLE,P(&v));say("Could not protect this spawn; vehicle removed");}
        }else say("Vehicle creation failed");}
        if(job==2){N(SET_PLAYER_MODEL,0,h);N(SET_PED_DEFAULT_COMPONENT_VARIATION,ped());say("Model changed; restore protagonist for missions");}
        if(job==3){u32 pickup=N(CREATE_AMBIENT_PICKUP,hash("PICKUP_MONEY_CASE"),point[0],point[1],point[2],0,10000,h,0,1);say(pickup?"Cash pickup created":"Pickup creation failed");}
        if(job==4){u64 low[4]={0},high[4]={0};N(GET_MODEL_DIMENSIONS,h,P(low),P(high));u32 object=N(CREATE_OBJECT_NO_OFFSET,h,F(0),F(0),F(-200),0,0,0);float top=as_float(high[2]);if(object&&top>-100&&top<100){N(SET_ENTITY_VISIBLE,object,0,0);N(FREEZE_ENTITY_POSITION,object,1);mailbox.platform=object;mailbox.platform_top=top;frame_flag(32,1);say("Water driving enabled");}else{menu.flags[WATER]=0;if(object)N(DELETE_OBJECT,P(&object));say("Water platform creation failed");}}
        u32 pinned=0;for(u32 i=0;i<3;i++)if(menu.warm_pins[i]==h)pinned=1;
        if(!pinned)N(SET_MODEL_AS_NO_LONGER_NEEDED,h);menu.job=0;
    }else if(menu.job==5){u32 h=hash(weapon_names[menu.step++]);if(N(IS_WEAPON_VALID,h))N(GIVE_WEAPON_TO_PED,p,h,9999,0,0);if(menu.step==sizeof(weapon_names)/sizeof(weapon_names[0])){menu.job=0;say("Weapon catalogue given");}}
    else if(menu.job==6){u32 v=car();if(v!=menu.vehicle||N(GET_ENTITY_MODEL,v)!=menu.vehicle_model){menu.job=0;say("Vehicle changed; upgrades stopped");return;}const u32 slots[]={11,12,13,15,16};if(menu.step<5){u32 slot=slots[menu.step++];int count=N(GET_NUM_VEHICLE_MODS,v,slot);if(count>0&&count<=100&&(int)N(GET_VEHICLE_MOD,v,slot)!=count-1){N(SET_VEHICLE_MOD,v,slot,count-1,0);if((int)N(GET_VEHICLE_MOD,v,slot)!=count-1){menu.job=0;say("Upgrade verification failed");}}}else{if(!N(IS_TOGGLE_MOD_ON,v,18))N(TOGGLE_VEHICLE_MOD,v,18,1);menu.job=0;say(N(IS_TOGGLE_MOD_ON,v,18)?"Performance upgrades checked and applied":"Turbo verification failed");}}
    else if(menu.job==7)teleport_tick(p);
    else if(menu.job==8){int c=protagonist();if(c<0||c!=(int)menu.character||!N(STAT_SET_INT,stat(skill_names[menu.step],c),100,1)){menu.job=0;say("Skill update stopped");return;}if(++menu.step==7){menu.job=0;say("Seven skills saved at 100");}}
    else if(menu.job==9){N(GIVE_ACHIEVEMENT_TO_PLAYER,menu.step++);if(menu.step>77){menu.job=0;say("Requests sent; check trophies for actual unlocks");}}
}
static void run_job(void) {
    u32 began=now(),old=menu.job;
    // No deliberate frame-per-item delay for cheap operations. The bounded
    // batch yields after 2 ms or 8 steps; model/collision jobs always yield.
    for(u32 work=0;menu.job&&work<8;work++){
        u32 job=menu.job;job_tick();
        if(!menu.job||job<=4||job==7||job==9||job==10||now()-began>=2)break;
    }
    if(old&&!menu.job)menu.last_job_ms=now()-menu.started;
}
static u64 prologue_program(void) {
    u64 g=GTA_SCRIPT_REGISTRY,count=*(u32*)(g+0x50),entries=*(u64*)(g+0x40),buckets=*(u64*)(g+0x48);
    if(!count||count>65536||!entries||!buckets||*(u32*)(g+0x1c)!=16)return 0;
    int index=*(int*)(buckets+(4024280498u%count)*4);
    for(u32 n=0;index>=0&&index<16384&&n<16384;n++){
        u64 e=entries+index*12;if(*(u32*)e==4024280498u){int slot=*(int*)(e+4);if(slot<0||slot>=16384)return 0;u64 base=*(u64*)(g+8);if(!base)return 0;u64 p=*(u64*)(base+slot*16);return p&&*(u32*)(p+0x58)==4024280498u?p:0;}index=*(int*)(e+8);
    }return 0;
}
static void prologue_tick(void) {
    if(!GTA_PROLOGUE_LENGTH){menu.job=0;say("Prologue recovery is not verified for this build");return;}
    u64 program=prologue_program();
    if(!program||*(u32*)(program+0x1c)!=GTA_PROLOGUE_LENGTH){menu.job=0;say("Exact supported Prologue is not running");return;}
    u64 pages=*(u64*)(program+0x10);if(!pages){menu.job=0;return;}
    u32 start=menu.prologue_offset,end=start+16384;if(end>GTA_PROLOGUE_LENGTH)end=GTA_PROLOGUE_LENGTH;
    u64 bytes=*(u64*)(pages+(start/16384)*8);if(!bytes){menu.job=0;return;}
    for(u32 i=start;i<end;i++){menu.prologue_hash^=*(u8*)(bytes+i%16384);menu.prologue_hash*=1099511628211ULL;}menu.prologue_offset=end;
    if(end<GTA_PROLOGUE_LENGTH)return;menu.job=0;
    if(menu.prologue_hash!=GTA_PROLOGUE_FNV){say("Prologue bytecode differs; completion refused");return;}
    u64 table=*(u64*)GTA_THREAD_TABLE;u32 count=*(unsigned short*)(GTA_THREAD_TABLE+8);u64 found=0;
    if(!table||!count||count>1024){say("Invalid script collection");return;}
    for(u32 i=0;i<count;i++){u64 t=*(u64*)(table+i*8);if(t&&*(u32*)(t+GTA_THREAD_HASH_OFFSET)==4024280498u&&*(u32*)(t+8)&&*(u32*)(t+GTA_THREAD_STATE_OFFSET)!=2){if(found){say("Multiple Prologue threads; refused");return;}found=t;}}
    if(!found){say("Prologue thread is no longer active");return;}
    u64 stack=*(u64*)(found+GTA_THREAD_STACK_OFFSET);if(!stack||*(u32*)(stack+2*8)!=1||*(u32*)(stack+3*8)!=134){say("Prologue state differs; refused");return;}
    u32 stage=*(volatile u32*)(stack+GTA_PROLOGUE_STAGE_LOCAL*8);if(stage<1||stage>15){say("Prologue is not eligible for completion");return;}
    *(volatile u32*)(stack+GTA_PROLOGUE_STAGE_LOCAL*8)=GTA_PROLOGUE_COMPLETE_STAGE;say("Normal Prologue completion requested");
}
static void resident_effects(void) {
    u32 p=ped(),v=car();if(!p)return;
    u64 root=*(volatile u64*)GTA_PLAYER_ROOT,entity=root?*(volatile u64*)(root+8):0;
    if(entity){u64 weapons=*(volatile u64*)(entity+0x1090);if(weapons){u8 b=*(volatile u8*)(weapons+0x71);b=(b&~3)|(menu.flags[AMMO]?1:0)|(menu.flags[CLIP]?2:0);*(volatile u8*)(weapons+0x71)=b;}}
    if(p!=menu.last_ped){menu.last_ped=p;N(SET_ENTITY_INVINCIBLE,p,menu.flags[GOD]);N(SET_RUN_SPRINT_MULTIPLIER_FOR_PLAYER,0,F(menu.flags[RUN]?1.49f:1));N(SET_PED_CONFIG_FLAG,p,32,!menu.flags[BELT]);N(SET_PED_CAN_BE_KNOCKED_OFF_VEHICLE,p,menu.flags[BELT]?1:0);}
    if(v!=menu.last_vehicle){if(menu.last_vehicle&&N(DOES_ENTITY_EXIST,menu.last_vehicle)&&menu.flags[CAR_GOD]){N(SET_ENTITY_INVINCIBLE,menu.last_vehicle,0);N(SET_VEHICLE_TYRES_CAN_BURST,menu.last_vehicle,1);N(SET_VEHICLE_CAN_BREAK,menu.last_vehicle,1);}menu.last_vehicle=v;if(v&&menu.flags[CAR_GOD]){N(SET_ENTITY_INVINCIBLE,v,1);N(SET_VEHICLE_TYRES_CAN_BURST,v,0);N(SET_VEHICLE_CAN_BREAK,v,0);}}
}
static void menu_input(u32 keys) {
    u32 edge=keys&~menu.previous_keys;menu.previous_keys=keys;
    if((keys&1)&&(edge&2)){menu.open=!menu.open;menu.confirm=0;edge=0;}
    if(!menu.open)return;
    if((edge&128)&&menu.preview_active){menu.preview_camera_enabled=!menu.preview_camera_enabled;if(!menu.preview_camera_enabled)preview_camera_stop();}
    if(edge&64){if(menu.confirm)menu.confirm=0;else if(menu.page)back_page();else menu.open=0;return;}
    u32 direction=keys&12;
    if(direction&&(direction&(direction-1))==0&&!(keys&1)&&!menu.confirm){
        if(menu.repeat_key!=direction){menu.repeat_key=direction;menu.repeat_at=now()+320;}
        else if((int)(now()-menu.repeat_at)>=0){edge|=direction;menu.repeat_at=now()+85;}
    }else menu.repeat_key=0;
    if(menu.confirm){if(edge&32){menu.confirm=0;activate(1);}}
    else {u32 n=rows();if(edge&4)menu.row=(menu.row+n-1)%n;if(edge&8)menu.row=(menu.row+1)%n;scroll_to_selection();if(edge&32)activate(0);}
}
static const char *description(void) {
    if(menu.page==0){switch(menu.row){case 0:return "Health, movement and police controls.";case 1:return "Ammo, explosive rounds and your arsenal.";case 2:return "Performance, repairs and vehicle abilities.";case 3:return "Browse models; they preload as you choose.";case 4:return "Waypoints, weather and the time of day.";case 5:return "Player models and live clothing choices.";case 6:return "Save-changing actions ask for confirmation.";default:return "Return to the game. Your toggles stay active.";}}
    int t=toggle_at(menu.page,menu.row);if(t>=0){switch(t){case WANTED:return "Continuously clears your wanted level.";case GOD:return "Protect your character from damage.";case CLIP:return "Fire continuously without reloading.";case AMMO:return "Keep the game's unlimited ammo flag enabled.";case RUN:return "Use the game's supported 1.49x sprint boost.";case CAR_GOD:return "Protection follows the vehicle you enter.";case WATER:return "Creates a hidden water-surface platform.";case HORN:return "Hold the horn to accelerate your vehicle.";default:return "Cross toggles this ability on or off.";}}
    if(menu.page==4)return "Choose a category. Only registered models are listed.";
    if(menu.page==15)return "Cross spawns this vehicle and seats you in it.";
    if(menu.page==3&&menu.row==1)return "Max performance parts; skip installed upgrades.";
    if(menu.page==5)return menu.row==0?"Streams destination collision before teleporting.":"Cross opens the list of choices.";
    if(menu.page==6)return menu.row==0?"Choose a character model.":"Choose clothing by body slot, item and texture.";
    if(menu.page==11)return "Shirts, upper layers, trousers, shoes and accessories.";
    if(menu.page==12||menu.page==13){
        u32 d=menu.page==12?menu.row:menu.drawable,t=menu.page==13?menu.row:0;
        copy(menu.clothing_detail,"Style ",96);append_number(menu.clothing_detail,d+1,96);append(menu.clothing_detail," / ",96);append_number(menu.clothing_detail,N(GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS,ped(),menu.component),96);
        append(menu.clothing_detail,"    Color ",96);append_number(menu.clothing_detail,t+1,96);append(menu.clothing_detail," / ",96);append_number(menu.clothing_detail,N(GET_NUMBER_OF_PED_TEXTURE_VARIATIONS,ped(),menu.component,d),96);return menu.clothing_detail;
    }
    if(menu.page==8)return "Cross gives and equips this weapon.";
    if(menu.page==10)return "Cross selects a model; confirmation is required.";
    if(menu.page>=9)return "Up / Down: browse. Cross: apply this choice.";
    if(menu.page==7)return "Changes progression or saves. Confirm before applying.";
    return "Cross applies. Circle returns to the previous menu.";
}
static void render_menu(void) {
    const float left=.650f,width=.320f,center=.810f,top=.088f;
    u32 n=rows();scroll_to_selection();u32 visible=n<9?n:9;float dt=as_float(N(GET_FRAME_TIME));if(dt<=0||dt>.1f)dt=.033f;
    float blend=dt*18;if(blend>1)blend=1;menu.highlight+=((menu.row-menu.scroll)-menu.highlight)*blend;
    float bottom=.258f+visible*.036f;
    rect(center+.004f,(top+bottom+.15f)/2,width+.012f,bottom+.15f-top,0,0,0,100);
    rect(center,(top+bottom+.15f)/2,width,bottom+.15f-top,12,16,22,245);
    rect(center,.145f,width,.114f,19,26,34,255);
    rect(left+.002f,.145f,.004f,.114f,94,234,171,255);
    text(left+.017f,.099f,.24f,"STORY MODE  /  PS5",1);
    text(left+.015f,.126f,.80f,"GTA V",0);
    text(left+.018f,.211f,.27f,title(menu.page),1);
    char count[24],part[12];number(count,menu.row+1);u32 at=0;while(count[at])at++;copy(count+at," / ",24-at);at+=3;number(part,n);copy(count+at,part,24-at);text(left+width-.060f,.211f,.27f,count,0);
    rect(center,.249f,width-.030f,.001f,60,71,82,255);
    if(menu.confirm){
        rect(center,.348f,width-.028f,.163f,30,39,49,255);
        text(left+.025f,.280f,.37f,"CONFIRM ACTION",1);
        text(left+.025f,.326f,.29f,"This can affect saves or progression.",0);
        text(left+.025f,.373f,.29f,"Cross: confirm    Circle: cancel",0);
    }else{
        rect(center,.276f+menu.highlight*.036f,width-.018f,.034f,35,61,55,250);
        rect(left+.011f,.276f+menu.highlight*.036f,.003f,.030f,94,234,171,255);
        for(u32 line=0;line<visible;line++){u32 i=menu.scroll+line;
            const char *name=label(i);u32 length=0;while(name[length])length++;
            float y=.263f+line*.036f;text(left+.023f,y,length>32?.25f:.30f,name,i==menu.row);
            int t=toggle_at(menu.page,i);
            if(t>=0){float x=left+width-.033f;rect(x,y+.013f,.036f,.020f,menu.flags[t]?69:50,menu.flags[t]?155:59,menu.flags[t]?115:67,255);text(x-.014f,y+.002f,.22f,menu.flags[t]?"ON":"OFF",0);}
            else if(menu.page==0||menu.page==4||menu.page==6||menu.page==11||(menu.page==2&&i==3)||(menu.page==3&&i==7)||(menu.page==5&&i>0))text(left+width-.031f,y,.30f,">",1);
        }
    }
    if(!menu.confirm&&n>visible){float track=visible*.036f,thumb=track*visible/n;
        rect(left+width-.004f,.258f+track/2,.002f,track,40,48,57,255);
        rect(left+width-.004f,.258f+thumb/2+(track-thumb)*menu.scroll/(n-visible),.002f,thumb,94,234,171,255);
    }
    text(left+.020f,bottom+.012f,.25f,description(),0);
    const char *status="DIRECT GAME CONTROL";
    if(menu.job)status=menu.job<=4?"LOADING MODEL...":menu.job==7?"LOADING DESTINATION...":"APPLYING...";
    else if((int)(menu.notice_until-now())>0)status=menu.notice;
    else if(menu.page==15||menu.page==10)status=menu.warm_unavailable?"MODEL NOT REGISTERED - CHECK DLC":menu.warm_ready?"SELECTED MODEL READY":"PRELOADING SELECTED MODEL...";
    text(left+.020f,bottom+.041f,.24f,status,1);
    rect(center,bottom+.078f,width-.030f,.001f,60,71,82,255);
    text(left+.020f,bottom+.089f,.24f,menu.preview_active?"D-pad: preview    Cross: keep    Circle: back":"D-pad: browse    Cross: select    Circle: back",0);
    text(left+.020f,bottom+.116f,.23f,menu.preview_active?"Square: preview camera    L1 + Right: close":"Sticks: move / look    L1 + Right: close",0);
    if(menu.preview_active){
        rect(.225f,.14f,.39f,.125f,12,16,22,230);text(.045f,.09f,.28f,"LIVE OUTFIT PREVIEW",1);
        text(.045f,.128f,.29f,component_name(menu.component),0);
        text(.045f,.167f,.24f,car()?"Exit the vehicle for the preview camera.":"Cross keeps your choice. Back cancels browsing.",0);
    }
    menu.renders++;mailbox.menu_renders=menu.renders;
}
static void block_menu_buttons(void) {
    // Reserve the menu buttons and their gameplay aliases. Neither stick,
    // camera axes, walking axes nor vehicle steering is disabled.
    const u32 controls[]={14,15,18,19,20,21,27,37,42,43,45,46,47,48,51,52,54,57,58,70,73,74,80,85,101,103,104,105,114,115,119,120,132,136,140,141,142,143,172,173,174,175,191,194,201,202};
    for(u32 i=0;i<ITEMS(controls);i++){N(DISABLE_CONTROL_ACTION,0,controls[i],1);N(DISABLE_CONTROL_ACTION,2,controls[i],1);}
    if(menu.preview_active){N(DISABLE_CONTROL_ACTION,0,22,1);N(DISABLE_CONTROL_ACTION,0,193,1);N(DISABLE_CONTROL_ACTION,2,193,1);}
}
static void menu_tick(void) {
    if(!mailbox.menu_enabled)return;
    if(*(volatile u8*)GTA_NETWORK_FLAG){preview_camera_stop();menu.preview_active=0;if(menu.job==7){teleport_cleanup();menu.job=0;}return;}
    u32 frame=N(GET_FRAME_COUNT);if(frame==menu.frame)return;menu.frame=frame;menu.tick_count++;
    mailbox.menu_ticks=menu.tick_count;
    if(!menu.initialized){menu.initialized=1;menu.hour=12;menu.component=11;menu.flags[WANTED]=(mailbox.frame_flags&64)!=0;menu.flags[JUMP]=(mailbox.frame_flags&1)!=0;menu.flags[EXPLOSIVE]=(mailbox.frame_flags&2)!=0;menu.flags[HORN]=(mailbox.frame_flags&4)!=0;menu.flags[STICKY]=(mailbox.frame_flags&8)!=0;menu.flags[PHONE]=(mailbox.frame_flags&16)!=0;u64 root=*(volatile u64*)GTA_PLAYER_ROOT,entity=root?*(volatile u64*)(root+8):0;if(entity){menu.flags[GOD]=(*(volatile u32*)(entity+0x158)&0x100)!=0;u64 w=*(volatile u64*)(entity+0x1090);if(w){menu.flags[AMMO]=(*(volatile u8*)(w+0x71)&1)!=0;menu.flags[CLIP]=(*(volatile u8*)(w+0x71)&2)!=0;}u64 info=*(volatile u64*)(entity+0x1088);if(info)menu.flags[RUN]=*(volatile float*)(info+GTA_RUN_OFFSET)>1.01f;}if(mailbox.seed_version==1){for(u32 i=0;i<TOGGLE_COUNT;i++)menu.flags[i]=mailbox.seed_flags[i]!=0;}say("GTA V loaded | L1 + D-pad Right");}
    catalogue_tick();resident_effects();
    // Read held keys and detect edges ourselves; works with blocked game controls.
    u32 keys=0;const u32 controls[]={37,175,172,173,174,191,194,193};
    for(u32 i=0;i<8;i++)if(N(IS_DISABLED_CONTROL_PRESSED,0,controls[i]))keys|=1u<<i;
    menu_input(keys);
    preview_tick();prefetch_tick();run_job();if(menu.job==10)prologue_tick();
    if(menu.open){
        block_menu_buttons();
        render_menu();
    }
    mailbox.menu_job=menu.job;mailbox.job_elapsed=menu.job?now()-menu.started:0;
    mailbox.last_job_ms=menu.last_job_ms;mailbox.selection=(menu.page<<16)|menu.row;
    mailbox.warm_model=menu.warm_model;mailbox.warm_ready=menu.warm_ready;
    mailbox.menu_open=menu.open;
    if(!menu.open&&(int)(menu.notice_until-now())>0){rect(.50f,.92f,.68f,.045f,13,26,21,225);text(.175f,.905f,.31f,menu.notice,1);}
}
