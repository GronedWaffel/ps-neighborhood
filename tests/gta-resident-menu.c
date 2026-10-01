#include <assert.h>
#include <stdio.h>
#include <string.h>
#define GTA_MENU_TEST
#define _start gta_test_entry
#include "../trainers/gta5-story/bridge.c"
static unsigned writes, clears, model_requests, stat_writes, car_id=99, time_now=100, model_loaded, spawned, model_releases;
static unsigned waypoint_exists=1,scene_active,scene_loaded,scene_start_ok=1,scene_starts,scene_stops,focus_sets,focus_clears,teleports,ground_available,ground_queries;
static float ground_height=288.0f,teleported_z;static u64 teleported_entity;
static int mods[20], turbo;
static unsigned given,disabled[400],unavailable,first_requested;
static unsigned outfit_slot,outfit_item,outfit_texture,other_draw[12],other_texture[12];
static unsigned decor_flags=0x20,decor_registered=1,decor_ok=1,seated,deleted,rendering_cam,destroyed_cam,model_id=12345;
static u64 menu_test_native(u64 h,u32 count,u64 *a,u64 *out){
    (void)count;(void)out;
    if(h==H_GET_FIRST_BLIP_INFO_ID)return waypoint_exists?123:0;
    if(h==H_DOES_BLIP_EXIST)return waypoint_exists;
    if(h==H_GET_BLIP_INFO_ID_COORD){out[0]=F(-650);out[1]=F(1135);out[2]=F(20);return 0;}
    if(h==H_IS_NEW_LOAD_SCENE_ACTIVE)return scene_active;
    if(h==H_IS_NEW_LOAD_SCENE_LOADED)return scene_loaded;
    if(h==H_NEW_LOAD_SCENE_START_SPHERE){assert(as_float(a[3])==400);scene_starts++;scene_active=scene_start_ok;return scene_start_ok;}
    if(h==H_NEW_LOAD_SCENE_STOP){scene_active=0;scene_stops++;return 0;}
    if(h==H_SET_FOCUS_POS_AND_VEL){focus_sets++;return 0;}
    if(h==H_CLEAR_FOCUS){focus_clears++;return 0;}
    if(h==H_REQUEST_COLLISION_AT_COORD)return 0;
    if(h==H_GET_GROUND_Z_FOR_3D_COORD){assert(as_float(a[2])==1500&&a[4]==0);ground_queries++;*(float*)a[3]=ground_height;return ground_available;}
    if(h==H_SET_ENTITY_COORDS_NO_OFFSET){teleports++;teleported_entity=a[0];teleported_z=as_float(a[3]);return 0;}
    if(h==H_GET_GAME_TIMER)return time_now;
    if(h==H_PLAYER_PED_ID)return 11;
    if(h==H_GET_VEHICLE_PED_IS_IN)return car_id;
    if(h==H_GET_ENTITY_MODEL)return model_id;
    if(h==H_GET_NUM_MOD_KITS)return 1;
    if(h==H_GET_VEHICLE_MOD_KIT)return 0;
    if(h==H_GET_NUM_VEHICLE_MODS)return 4;
    if(h==H_GET_VEHICLE_MOD)return mods[a[1]];
    if(h==H_SET_VEHICLE_MOD){assert(a[1]==11||a[1]==12||a[1]==13||a[1]==15||a[1]==16);mods[a[1]]=a[2];writes++;return 0;}
    if(h==H_IS_TOGGLE_MOD_ON)return turbo;
    if(h==H_TOGGLE_VEHICLE_MOD){assert(a[1]==18);turbo=a[2];writes++;return 0;}
    if(h==H_CLEAR_PLAYER_WANTED_LEVEL){assert(a[0]==0);clears++;return 0;}
    if(h==H_IS_MODEL_IN_CDIMAGE||h==H_IS_MODEL_VALID||h==H_IS_MODEL_A_VEHICLE)return a[0]!=unavailable;
    if(h==H_REQUEST_MODEL){if(!first_requested)first_requested=a[0];model_requests++;return 0;}
    if(h==H_HAS_MODEL_LOADED)return model_loaded;
    if(h==H_SET_MODEL_AS_NO_LONGER_NEEDED){model_releases++;return 0;}
    if(h==H_GET_OFFSET_FROM_ENTITY_IN_WORLD_COORDS){out[0]=F(10);out[1]=F(20);out[2]=F(30);return 0;}
    if(h==H_GET_ENTITY_HEADING)return F(90);
    if(h==H_CREATE_VEHICLE){spawned++;return 99;}
    if(h==H_DOES_ENTITY_EXIST)return 1;
    if(h==H_SET_VEHICLE_ON_GROUND_PROPERLY)return 0;
    if(h==H_SET_PED_INTO_VEHICLE){assert(decor_flags&0x40000000u);seated++;return 0;}
    if(h==H_DECOR_IS_REGISTERED_AS_TYPE)return decor_registered;
    if(h==H_DECOR_EXIST_ON)return 1;
    if(h==H_DECOR_GET_INT)return decor_flags;
    if(h==H_DECOR_SET_INT){if(decor_ok)decor_flags=a[2];return decor_ok;}
    if(h==H_DELETE_VEHICLE){deleted++;*(u32*)a[0]=0;return 0;}
    if(h==H_STAT_SET_INT){stat_writes++;return 1;}
    if(h==H_IS_WEAPON_VALID)return 1;
    if(h==H_GIVE_WEAPON_TO_PED){assert(a[4]==1);given++;return 0;}
    if(h==H_DISABLE_CONTROL_ACTION){assert(a[1]<400);disabled[a[1]]++;return 0;}
    if(h==H_GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS)return a[1]==1?0:model_id==2602752943u?32:4;
    if(h==H_GET_NUMBER_OF_PED_TEXTURE_VARIATIONS)return model_id==2602752943u?16:3;
    if(h==H_SET_PED_COMPONENT_VARIATION){outfit_slot=a[1];if(a[1]==3){outfit_item=a[2];outfit_texture=a[3];}else{other_draw[a[1]]=a[2];other_texture[a[1]]=a[3];}return 0;}
    if(h==H_GET_PED_DRAWABLE_VARIATION)return a[1]==3?outfit_item:other_draw[a[1]];
    if(h==H_GET_PED_TEXTURE_VARIATION)return a[1]==3?outfit_texture:other_texture[a[1]];
    if(h==H_GET_PED_PALETTE_VARIATION)return 0;
    if(h==H_GET_RENDERING_CAM)return rendering_cam;
    if(h==H_IS_GAMEPLAY_CAM_RENDERING)return !rendering_cam;
    if(h==H_IS_CUTSCENE_ACTIVE)return 0;
    if(h==H_CREATE_CAM)return 77;
    if(h==H_SET_CAM_COORD||h==H_POINT_CAM_AT_ENTITY||h==H_SET_CAM_FOV)return 0;
    if(h==H_RENDER_SCRIPT_CAMS){rendering_cam=a[0]?77:0;return 0;}
    if(h==H_DESTROY_CAM){assert(a[0]==77);destroyed_cam++;return 0;}
    if(h==H_GET_HASH_NAME_FOR_COMPONENT)return 0;
    if(h==H_DOES_TEXT_LABEL_EXIST)return 0;
    assert(!"Unexpected native in test");return 0;
}
static void select_vehicle(const char *name){
    for(unsigned i=0;i<menu.vehicle_total;i++){
        unsigned index=menu.available_vehicles[i];if(vehicle_catalogue[index].model==hash(name)){
            menu.vehicle_class=vehicle_catalogue[index].category;menu.page=15;menu.row=i-menu.class_first[menu.vehicle_class];return;
        }
    }assert(!"Vehicle missing in test catalogue");
}
int main(void){
    memset(&menu,0,sizeof(menu));memset(mods,0xff,sizeof(mods));
    unavailable=hash("t20");while(menu.vehicle_scan<VEHICLE_CANDIDATES)catalogue_tick();assert(menu.vehicle_total==VEHICLE_CANDIDATES-1);
    unavailable=0;memset(&menu,0,sizeof(menu));while(menu.vehicle_scan<VEHICLE_CANDIDATES)catalogue_tick();assert(menu.vehicle_total==VEHICLE_CANDIDATES&&menu.class_total==22);
    assert(ITEMS(weapon_labels)==ITEMS(weapon_names));
    menu_input(3);assert(menu.open==1);menu_input(3);assert(menu.open==1);
    menu_input(0);menu_input(8);assert(menu.row==1);menu_input(8);assert(menu.row==1);
    menu.page=1;menu.row=1;menu_input(0);menu_input(32);assert(menu.flags[WANTED]&&clears==1&&(mailbox.frame_flags&64));
    menu_input(32);assert(clears==1);menu_input(0);menu_input(32);assert(!menu.flags[WANTED]&&!(mailbox.frame_flags&64));
    menu.page=3;menu.row=1;activate(0);assert(menu.job==6);for(int i=0;i<6;i++)job_tick();assert(writes==6&&!menu.job);
    activate(0);for(int i=0;i<6;i++)job_tick();assert(writes==6&&!menu.job);
    activate(0);car_id=100;job_tick();assert(!menu.job&&writes==6);car_id=99;
    menu.page=7;menu.row=0;activate(0);assert(menu.confirm&&stat_writes==0);menu_input(0);menu_input(64);assert(!menu.confirm&&stat_writes==0);
    begin_model(1,"adder");assert(menu.job==1&&model_requests==1);time_now+=16000;job_tick();assert(!menu.job);
    menu.previous_keys=menu.repeat_key=0;menu.page=0;menu.row=0;menu.open=1;
    menu_input(8);assert(menu.row==1);time_now+=319;menu_input(8);assert(menu.row==1);time_now++;menu_input(8);assert(menu.row==2);time_now+=85;menu_input(8);assert(menu.row==3);
    select_vehicle("adder");menu.spawn=0;menu.job=0;
    unsigned before=model_requests;first_requested=0;prefetch_tick();assert(model_requests==before);time_now+=101;prefetch_tick();assert(model_requests>before&&first_requested==hash("adder"));
    assert(menu.warm_pins[0]&&menu.warm_pins[1]&&menu.warm_pins[2]);
    model_loaded=1;prefetch_tick();assert(menu.warm_ready);
    activate(0);assert(menu.job==1);run_job();assert(!menu.job&&spawned==1&&menu.last_job_ms==0);
    menu.row++;prefetch_tick();assert(menu.warm_ready&&menu.warm_model==vehicle_hash(menu.row)); // Adjacent choice is ready without debounce.
    unsigned releases=model_releases;menu.page=0;prefetch_tick();assert(!menu.warm_model&&model_releases==releases+3);
    select_vehicle("t20");unavailable=hash("t20");prefetch_tick();time_now+=101;prefetch_tick();assert(menu.warm_unavailable&&!menu.warm_model);
    before=spawned;activate(0);assert(!menu.job&&spawned==before);unavailable=0;
    select_vehicle("adder");prefetch_tick();time_now+=101;prefetch_tick();menu.model=hash("adder");menu.job=1;releases=model_releases;
    menu.page=0;prefetch_tick();assert(model_releases==releases+2);run_job();assert(!menu.job&&model_releases==releases+3); // Active job retains ownership after leaving.
    menu.page=3;menu.row=1;activate(0);run_job();assert(!menu.job&&writes==6); // Complete repeat check in one budgeted batch.
    menu.job=1;menu.page=1;menu.row=1;activate(0);assert(menu.flags[WANTED]&&menu.job==1); // Streaming does not lock toggles.
    menu.job=0;menu.page=3;menu.row=7;activate(0);assert(menu.page==4);menu.previous_keys=0;menu_input(64);assert(menu.page==3&&menu.row==7);
    menu.job=0;menu.page=0;menu.row=1;menu.history_count=0;activate(0);assert(menu.page==2);
    menu.row=3;activate(0);assert(menu.page==8&&rows()==ITEMS(weapon_names));
    menu.row=ITEMS(weapon_names)-1;scroll_to_selection();assert(menu.scroll==rows()-9);assert(menu.row-menu.scroll==8);
    menu.previous_keys=0;menu_input(8);assert(menu.row==0&&menu.scroll==0);
    menu.previous_keys=0;menu_input(4);assert(menu.row==rows()-1&&menu.scroll==rows()-9);
    menu.row=11;activate(0);assert(given==1);
    menu.previous_keys=0;menu_input(64);assert(menu.page==2&&menu.row==3);
    menu.previous_keys=0;menu_input(64);assert(menu.page==0&&menu.row==1);
    menu.page=4;menu.row=0;menu.history_count=0;activate(0);assert(menu.page==15&&menu.vehicle_class==7&&rows()>40);
    menu.row=rows()-1;scroll_to_selection();assert(menu.scroll==rows()-9);
    before=menu.row;menu.previous_keys=0;menu_input(2);assert(menu.row==before); // Right no longer cycles choices.
    back_page();assert(menu.page==4&&menu.row==0);
    menu.page=0;menu.row=5;menu.history_count=0;activate(0);assert(menu.page==6);menu.row=1;activate(0);assert(menu.page==11);
    menu.row=8;activate(0);assert(menu.page==11); // Empty clothing slot does not open a fake item list.
    menu.row=0;activate(0);assert(menu.page==12);menu.row=1;activate(0);assert(menu.page==13&&outfit_slot==3&&outfit_item==1);
    menu.row=2;activate(0);assert(outfit_texture==2);back_page();assert(menu.page==12&&menu.row==1);back_page();assert(menu.page==11&&menu.row==0);
    block_menu_buttons();assert(disabled[21]&&disabled[27]&&disabled[45]);
    for(unsigned i=1;i<=6;i++)assert(!disabled[i]);
    for(unsigned i=30;i<=35;i++)assert(!disabled[i]);
    for(unsigned i=59;i<=67;i++)assert(!disabled[i]);
    assert(!disabled[71]&&!disabled[72]);
    assert(hash("player_two")==2608926626u);
    assert((decor_flags&0x40000020u)==0x40000020u);
    unsigned was_seated=seated;decor_registered=0;begin_model(1,"cyclone2");run_job();assert(deleted==1&&seated==was_seated);decor_registered=1;
    decor_flags=0x40;decor_ok=0;begin_model(1,"cyclone2");run_job();assert(deleted==2&&seated==was_seated&&decor_flags==0x40);decor_ok=1;
    preview_end();outfit_item=1;outfit_texture=2;menu.component=3;menu.page=12;menu.row=0;menu.open=1;car_id=0;
    preview_begin(11,3);preview_tick();assert(outfit_item==1&&rendering_cam==77);time_now+=121;preview_tick();assert(outfit_item==0&&outfit_texture==0);
    menu.page=11;preview_tick();assert(outfit_item==1&&outfit_texture==2&&!rendering_cam&&destroyed_cam==1);
    menu.page=12;preview_begin(11,3);menu.row=2;preview_tick();time_now+=121;preview_tick();preview_commit(2,0);menu.open=0;preview_tick();assert(outfit_item==2&&outfit_texture==0&&!rendering_cam);
    menu.open=1;menu.page=12;preview_begin(11,3);menu.row=0;preview_tick();time_now+=121;preview_tick();outfit_item=3;menu.open=0;preview_tick();assert(outfit_item==3); // Mission/external change is preserved.
    assert(strstr(clothing_name(2,1),"Torso #2"));
    model_id=2602752943u;outfit_item=12;outfit_texture=0;other_draw[11]=3;other_draw[8]=4;other_draw[9]=2;other_draw[10]=1;
    menu.component=3;preview_begin(11,3);outfit_apply(11,3,0,0);
    assert(outfit_item==0&&other_draw[11]==0&&other_draw[8]==0&&other_draw[9]==0&&other_draw[10]==0);
    preview_end();assert(outfit_item==12&&other_draw[11]==3&&other_draw[8]==4&&other_draw[9]==2&&other_draw[10]==1);
    preview_begin(11,3);outfit_apply(11,3,0,0);preview_commit(0,0);outfit_apply(11,3,4,0);assert(other_draw[11]==8);preview_end();assert(outfit_item==0&&other_draw[11]==0); // Cancel restores the complete committed outfit.
    menu.component=11;preview_begin(11,11);outfit_apply(11,11,3,0);assert(outfit_item==18&&other_draw[11]==3);preview_end();assert(outfit_item==0&&other_draw[11]==0);
    menu.component=3;preview_begin(11,3);outfit_apply(11,3,12,0);other_draw[11]=5;preview_end();assert(other_draw[11]==5); // Preserve externally changed accessory layers.
    char key[64];story_clothing_key(key,1,11,2,0);assert(!strcmp(key,"JBIB_P1_1_0"));story_clothing_key(key,1,11,4,3);assert(!strcmp(key,"JBIB_P1_3_3"));story_clothing_key(key,1,11,1,0);assert(!key[0]);
    assert(clothing_order[0]==3&&clothing_order[1]==11&&clothing_order[2]==4&&clothing_order[3]==6);
    preview_end();menu.job=0;car_id=99;scene_active=0;scene_loaded=0;
    teleport_start(11,99);assert(menu.job==7&&scene_starts==1&&menu.teleport_entity==99);teleport_tick(11);assert(!ground_queries&&!teleports); // A distant scene must load first.
    scene_loaded=1;ground_available=0;time_now+=100;teleport_tick(11);assert(ground_queries==1&&!teleports);
    ground_available=1;time_now+=100;teleport_tick(11);assert(teleports==1&&teleported_entity==99&&teleported_z==289&&menu.step==3&&scene_stops==0);
    time_now+=349;teleport_tick(11);assert(menu.job==7);time_now++;teleport_tick(11);assert(!menu.job&&scene_stops==1&&focus_clears==1);
    car_id=0;ground_available=0;teleport_start(11,0);time_now+=5001;teleport_tick(11);assert(menu.step==1&&scene_starts==3);time_now+=5001;teleport_tick(11);assert(menu.step==2);
    ground_available=1;ground_height=790;time_now+=100;teleport_tick(11);assert(teleported_entity==11&&teleported_z==791);time_now+=350;teleport_tick(11);assert(!menu.job&&!scene_active);
    unsigned moved=teleports;ground_available=0;teleport_start(11,0);for(int i=0;i<3;i++){time_now+=5001;teleport_tick(11);}assert(!menu.job&&!scene_active&&teleports==moved); // No land: never move to an invented altitude.
    scene_active=1;unsigned starts=scene_starts,stops=scene_stops,clears_before=focus_clears;teleport_start(11,0);assert(!menu.job&&scene_starts==starts&&scene_stops==stops&&focus_clears==clears_before);scene_active=0;
    scene_start_ok=0;teleport_start(11,0);assert(!menu.job&&!menu.teleport_focus&&!menu.teleport_scene);scene_start_ok=1;
    teleport_start(11,0);car_id=99;teleport_tick(11);assert(!menu.job&&!scene_active&&teleports==moved);car_id=0; // Never move a replacement entity.
    waypoint_exists=0;starts=scene_starts;teleport_start(11,0);assert(!menu.job&&scene_starts==starts);waypoint_exists=1;
    teleport_start(11,0);teleport_tick(0);assert(!menu.job&&!scene_active);
    puts("Resident menu: distant waypoint streaming, elevation retry, vehicle/on-foot teleport and cancellation cleanup, vehicle cleanup protection and failure handling, clothing preview/commit/cancel/camera cleanup, catalogue, input, streaming and progression checks passed.");return 0;
}
