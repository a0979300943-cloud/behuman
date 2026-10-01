/* behuman 开场剧情分镜数据 */
window.STORY = [
  {
    img: 'assets/scene1.svg',
    lines: [
      '我是一名星际航空员。',
      '日复一日，独自航行在寂静的深空航线上。',
      '直到一天，一段来自某个蓝色星球的信号，闯进了我的接收器——'
    ]
  },
  {
    img: 'assets/scene2.svg',
    lines: [
      '信号里，有一种叫做「快乐」的东西。',
      '笑声、晚风，还有街角彻夜不熄的灯光。',
      '那颗星球叫地球。我突然……很想成为他们中的一员。'
    ]
  },
  {
    img: 'assets/scene3.svg',
    lines: [
      '我穿上拟态伪装，驾驶小飞船，降落在这颗星球。'
    ]
  },
  {
    img: 'assets/scene4.svg',
    lines: [
      '我学着人类的样子走路、说话，在人群里发呆。',
      '地球的生活，温暖得不可思议。'
    ]
  },
  {
    img: 'assets/scene5.svg',
    lines: [
      '可伪装并不稳定——每隔一段时间，我就会变回原型。',
      '警报响起时，我必须立刻躲进无人的角落，屏住呼吸。',
      '一旦被发现，就再也做不成人类了。'
    ]
  },
  {
    img: 'assets/scene6.svg',
    lines: [
      '所以，每一次专注，都是一场不被发现的逃亡。',
      '嘘——帮我藏好身份。',
      '一起，成为人类吧！'
    ]
  }
];

/* 依据台词长度估算停留时长（毫秒） */
window.lineDuration = function (text) {
  const base = 1500;
  const per = 150;
  return Math.min(7000, base + text.length * per);
};

